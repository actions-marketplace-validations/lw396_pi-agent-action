import * as core from "@actions/core";
import type {
  Api,
  ClassifierApi,
  ClassifierModel,
  ClassifierQuestion,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import {
  resolveCliModel,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createModelRuntime, type ModelRuntimeOptions } from "./model-runtime";

/**
 * Classification of buffered inline comments as real review feedback or
 * test/probe calls, after the session ends.
 *
 * Upstream asks Claude Haiku through the Anthropic API. Here the model goes
 * through pi, so any provider works. classify_model picks it: a classifier
 * model (jev) answers one bool question per comment; a chat model gets
 * Upstream's prompt and answers with a JSON array. Without classify_model the
 * model input classifies, as a chat model. Any failure returns null, and
 * every comment is posted; another model is never tried.
 */

export type ClassifyOptions = ModelRuntimeOptions & {
  /** The model input: the session's model, in pi's `provider/id` form. */
  model?: string;
  /** The classify_model input: a classifier or chat model, `provider/id`. */
  classifyModel?: string;
  /** The api_key input: a key for the provider of the model input. */
  apiKey?: string;
  /** Tests pass a runtime with a scripted provider. */
  modelRuntime?: ModelRuntime;
};

const CRITERIA = {
  true: "Real review feedback: discusses specific code, logic, bugs or style, and gives the PR author something to act on.",
  false:
    "A test or probe: checks whether the commenting tool works, for example 'Test comment', 'Testing if', 'Can I', 'Does this work', 'Checking if', or has placeholder content not about any code.",
};

const CHAT_PROMPT = `You are classifying PR inline comments as either REAL code review feedback or TEST/PROBE calls.

A TEST/PROBE call is when an automated agent is checking whether a commenting tool works. These typically:
- Start with phrases like "Test comment", "Testing if", "Can I", "Does this work", "Checking if"
- Have generic/placeholder content not specific to any code
- Exist to verify tool functionality, not to provide review feedback

A REAL review comment:
- Discusses specific code, logic, bugs, or style
- Provides actionable feedback for the PR author
- References concrete aspects of the change

For each numbered comment body below, respond with ONLY a JSON array of booleans where true = REAL review comment, false = test/probe. No other text.

Comments:
`;

type ChatModel = Model<Api>;

type Choice =
  | { kind: "classifier"; model: ClassifierModel<ClassifierApi> }
  | { kind: "chat"; model: ChatModel };

/** Log why comments cannot be classified; every comment is then posted. */
function postAll(reason: string): null {
  core.info(`${reason} — posting all unconfirmed comments`);
  return null;
}

function findClassifier(
  modelRuntime: ModelRuntime,
  reference: string,
): ClassifierModel<ClassifierApi> | undefined {
  const slash = reference.indexOf("/");
  if (slash <= 0) return undefined;
  return modelRuntime.getModelOfType(
    "classifier",
    reference.slice(0, slash),
    reference.slice(slash + 1),
  );
}

/**
 * The model to classify with: classify_model as a classifier or chat model,
 * else the model input as a chat model. Undefined, after logging why, when
 * there is none.
 */
function chooseModel(
  modelRuntime: ModelRuntime,
  mainModel: ChatModel | undefined,
  classifyModel: string | undefined,
): Choice | undefined {
  if (classifyModel) {
    const classifier = findClassifier(modelRuntime, classifyModel);
    if (classifier) return { kind: "classifier", model: classifier };
    const chat = resolveCliModel({ cliModel: classifyModel, modelRuntime });
    if (chat.model) return { kind: "chat", model: chat.model };
    core.warning(
      `classify_model '${classifyModel}' is not a model pi knows (${chat.error}) — posting all unconfirmed comments`,
    );
    return undefined;
  }
  if (mainModel) return { kind: "chat", model: mainModel };
  postAll("No model to classify with");
  return undefined;
}

function logUsage(model: { provider: string; id: string }, usage?: Usage) {
  const spend = usage
    ? `${usage.totalTokens} tokens, cost $${usage.cost.total.toFixed(4)}`
    : "usage not reported";
  core.info(
    `Classified inline comments with ${model.provider}/${model.id}: ${spend}`,
  );
}

async function classifyWithClassifier(
  modelRuntime: ModelRuntime,
  model: ClassifierModel<ClassifierApi>,
  bodies: string[],
): Promise<boolean[] | null> {
  const keys = bodies.map((_, i) => `c${i + 1}`);
  const questions: Record<string, ClassifierQuestion> = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        type: "bool",
        instructions: `Is inline comment ${key} real code review feedback, rather than a test or probe of the commenting tool?`,
        criteria: CRITERIA,
      },
    ]),
  );
  const result = await modelRuntime.classify(model, {
    state: {
      comments: keys.map((id, i) => ({ id, body: bodies[i]! })),
    },
    questions,
  });
  logUsage(model, result.usage);
  if (result.stopReason !== "stop") {
    return postAll(
      `Classification failed (${result.errorMessage ?? result.stopReason})`,
    );
  }
  const verdicts = keys.map((key) => {
    const answer = result.answers[key];
    return answer?.type === "bool" ? answer.probability >= 0.5 : undefined;
  });
  if (verdicts.some((v) => v === undefined)) {
    return postAll("Classification response shape mismatch");
  }
  return verdicts as boolean[];
}

async function classifyWithChat(
  modelRuntime: ModelRuntime,
  model: ChatModel,
  bodies: string[],
): Promise<boolean[] | null> {
  const prompt =
    CHAT_PROMPT +
    bodies.map((b, i) => `${i + 1}. ${JSON.stringify(b)}`).join("\n");
  const response = await modelRuntime.complete(model, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  logUsage(model, response.usage);
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    return postAll(
      `Classification failed (${response.errorMessage ?? response.stopReason})`,
    );
  }
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return postAll("Could not parse classification response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== bodies.length ||
    !parsed.every((v) => typeof v === "boolean")
  ) {
    return postAll("Classification response shape mismatch");
  }
  return parsed;
}

/**
 * Classify comment bodies: true for real review feedback, false for a
 * test/probe. Null when classification is not possible, in which case every
 * comment should be posted. Never throws.
 */
export async function classifyComments(
  bodies: string[],
  options: ClassifyOptions,
): Promise<boolean[] | null> {
  try {
    const modelRuntime =
      options.modelRuntime ?? (await createModelRuntime(options));
    const mainReference = options.model?.trim();
    const main = mainReference
      ? resolveCliModel({ cliModel: mainReference, modelRuntime }).model
      : undefined;
    if (main && options.apiKey) {
      // Like the Runner: the key is for the model input's provider only.
      await modelRuntime.setRuntimeApiKey(main.provider, options.apiKey);
    }
    const choice = chooseModel(
      modelRuntime,
      main,
      options.classifyModel?.trim() || undefined,
    );
    if (!choice) return null;
    return choice.kind === "classifier"
      ? await classifyWithClassifier(modelRuntime, choice.model, bodies)
      : await classifyWithChat(modelRuntime, choice.model, bodies);
  } catch (e) {
    return postAll(
      `Classification failed (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
