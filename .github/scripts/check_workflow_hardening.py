#!/usr/bin/env python3
"""Fail if a workflow job that runs the agent, or .github/egress-firewall.yaml, breaks a rule in
AGENTS.md, "Security hardening for GitHub Actions". Run from the repository root. A job runs the
agent when it runs this action (published, or a local action with a pi_args input), or when it or a
local action it uses mentions the pi package, PI_PACKAGE.
"""

import json
import pathlib
import subprocess
import sys
from typing import NoReturn

FIREWALL_RUNNER = "ubuntu-24.04-firewall"
WORKFLOW_DIR = pathlib.Path(".github/workflows")
POLICY_PATH = pathlib.Path(".github/egress-firewall.yaml")
PI_PACKAGE = "@earendil-works/pi-coding-agent"
AGENT_ACTIONS = ("lw396/pi-agent-action",)
HELP = 'See AGENTS.md, "Security hardening for GitHub Actions".'
# A '*' in an allowed_tools tool name may only pick out MCP tools. Anywhere else it can name
# bash, edit or write, and turns the allowlist off without saying so.
MCP_TOOL_PREFIX = "mcp__"

# Key: "<workflow file name>:<job id>". Value: why that job is exempt from the table's rule.
EXEMPT_FROM_FIREWALL_RUNNER: dict[str, str] = {}
EXEMPT_FROM_TOOL_ALLOWLIST: dict[str, str] = {}


def stop(message: str) -> NoReturn:
    sys.exit(f"::error::{message}")


def load_yaml(path: pathlib.Path):
    """Parse a YAML file with PyYAML, or with the yq command if PyYAML is absent."""
    try:
        import yaml
    except ImportError:
        try:
            result = subprocess.run(
                ["yq", "-o=json", ".", str(path)], check=True, capture_output=True, text=True
            )
        except FileNotFoundError:
            stop(
                f"Cannot read {path}: Python has no 'yaml' module and no 'yq' command was found. "
                "Add a step that runs 'pip install pyyaml' before this check."
            )
        except subprocess.CalledProcessError:
            stop(f"Cannot read {path}: 'yq' could not parse it. Check that the file is valid YAML.")
        return json.loads(result.stdout)
    try:
        with path.open(encoding="utf-8") as handle:
            return yaml.safe_load(handle)
    except yaml.YAMLError as error:
        stop(f"Cannot read {path}: it is not valid YAML ({error}).")


def contains_marker(node) -> bool:
    """Whether any key or string under node contains PI_PACKAGE, ignoring case."""
    if isinstance(node, dict):
        return any(contains_marker(k) or contains_marker(v) for k, v in node.items())
    if isinstance(node, list):
        return any(contains_marker(item) for item in node)
    return isinstance(node, str) and PI_PACKAGE in node.lower()


def load_local_action(uses: str):
    """The parsed action file of a local action (uses: ./path), or None."""
    if not uses.startswith("./"):
        return None
    for name in ("action.yml", "action.yaml"):
        action_file = pathlib.Path(uses) / name
        if action_file.is_file():
            action = load_yaml(action_file)
            return action if isinstance(action, dict) else {}
    return None


def steps_of(job: dict) -> list[dict]:
    return [step for step in job.get("steps") or [] if isinstance(step, dict)]


def runs_agent_action(step: dict) -> bool:
    """Whether the step runs this action: the published action, or a local action that
    accepts a pi_args input."""
    uses = str(step.get("uses", ""))
    if uses.lower().startswith(AGENT_ACTIONS):
        return True
    action = load_local_action(uses)
    return action is not None and "pi_args" in (action.get("inputs") or {})


def job_runs_agent(job: dict) -> bool:
    if contains_marker(job):
        return True
    for step in steps_of(job):
        if runs_agent_action(step):
            return True
        action = load_local_action(str(step.get("uses", "")))
        if action is not None and contains_marker(action):
            return True
    return False


def split_tool_rules(text: str) -> list[str]:
    """Split an allowed_tools value into rules, as src/runner/tool-rules.ts does: separated by
    commas, spaces or newlines outside a rule's parentheses, with '#' comment lines dropped and
    quotes removed. Raises ValueError for unbalanced parentheses."""
    source = "\n".join(line for line in text.splitlines() if not line.strip().startswith("#"))
    rules, current, depth, quote = [], "", 0, None
    for char in source:
        if depth > 0:
            depth += {"(": 1, ")": -1}.get(char, 0)
            current += char
        elif quote:
            if char == quote:
                quote = None
            else:
                depth += char == "("
                current += char
        elif char in "\"'":
            quote = char
        elif char == "," or char.isspace():
            if current:
                rules.append(current)
            current = ""
        else:
            if char == ")":
                raise ValueError(f"'allowed_tools' has an unmatched ')' in '{current})'. Remove it")
            depth += char == "("
            current += char
    if depth > 0:
        raise ValueError(f"'allowed_tools' has an unmatched '(' in '{current}'. Close it")
    if current:
        rules.append(current)
    return rules


def tool_allowlist_problem(step: dict) -> str | None:
    """The message for a step whose allowed_tools turns the tool allowlist off, or None.

    A rule may name a tool with '*' only to pick out MCP tools (mcp__...). A '*' anywhere else
    can name bash, edit and write at once, so every call the allowlist is there to stop runs.
    """
    text = str((step.get("with") or {}).get("allowed_tools", ""))
    try:
        rules = split_tool_rules(text)
    except ValueError as error:
        return str(error)
    for rule in rules:
        name = rule.split("(", 1)[0]
        if "*" in name and not name.startswith(MCP_TOOL_PREFIX):
            return (
                f"remove '{rule}' from 'allowed_tools': a '*' in a tool name outside "
                f"'{MCP_TOOL_PREFIX}' tools can allow every tool. Name each tool the job needs"
            )
    return None


def check_job(file_name: str, job_id: str, job: dict) -> list[str]:
    key = f"{file_name}:{job_id}"
    where = f".github/workflows/{file_name}: job '{job_id}'"
    errors = []
    runs_on = job.get("runs-on")
    if isinstance(runs_on, list) and len(runs_on) == 1:
        runs_on = runs_on[0]
    if key in EXEMPT_FROM_FIREWALL_RUNNER:
        print(
            f"The egress-firewall runner is not required for job '{job_id}' in {file_name}. "
            f"Reason: {EXEMPT_FROM_FIREWALL_RUNNER[key]}."
        )
    elif runs_on != FIREWALL_RUNNER:
        if "runs-on" not in job:
            has = "no 'runs-on'"
        elif isinstance(job["runs-on"], str):
            has = f"'runs-on: {job['runs-on']}'"
        else:
            has = "a 'runs-on' list or group"
        errors.append(
            f"{where} runs the agent, so it must have 'runs-on: {FIREWALL_RUNNER}'. "
            f"It has {has}. {HELP}"
        )
    if key in EXEMPT_FROM_TOOL_ALLOWLIST:
        print(
            f"The tool allowlist check does not apply to job '{job_id}' in {file_name}. "
            f"Reason: {EXEMPT_FROM_TOOL_ALLOWLIST[key]}."
        )
        return errors
    for index, step in enumerate(steps_of(job), start=1):
        if not runs_agent_action(step):
            continue
        problem = tool_allowlist_problem(step)
        if problem:
            step_label = f"step '{step['name']}'" if "name" in step else f"step {index}"
            errors.append(f"{where}, {step_label}: {problem}. {HELP}")
    return errors


def check_policy() -> list[str]:
    if not POLICY_PATH.is_file():
        return [
            f"{POLICY_PATH} is missing. Jobs on the egress-firewall runner need it "
            f"to limit outbound network access. {HELP}"
        ]
    policy = load_yaml(POLICY_PATH)
    if not isinstance(policy, dict):
        return [
            f"{POLICY_PATH} is empty or is not a set of 'name: value' lines. It needs 'mode: enforce' "
            f"and an 'allow:' list of hosts. {HELP}"
        ]
    errors = []
    if "mode" not in policy:
        errors.append(f"{POLICY_PATH}: 'mode' is missing. Add 'mode: enforce'. {HELP}")
    elif policy["mode"] != "enforce":
        errors.append(
            f"{POLICY_PATH}: 'mode' is '{policy['mode']}'. It must be 'enforce'. {HELP}"
        )
    allow = policy.get("allow")
    if not isinstance(allow, list) or not allow:
        errors.append(
            f"{POLICY_PATH}: the 'allow' list is missing or empty. List under 'allow:' "
            f"each host the jobs need. {HELP}"
        )
    else:
        for host in allow:
            if "*" in str(host):
                errors.append(
                    f"{POLICY_PATH}: the 'allow' entry '{host}' contains '*'. "
                    f"Name each host in full. {HELP}"
                )
    return errors


def main() -> int:
    if not WORKFLOW_DIR.is_dir():
        stop(f"{WORKFLOW_DIR} not found. Run this check from the repository root.")
    errors = []
    checked = 0
    for path in sorted([*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")]):
        workflow = load_yaml(path)
        jobs = workflow.get("jobs") if isinstance(workflow, dict) else None
        for job_id, job in (jobs or {}).items():
            if not isinstance(job, dict) or not job_runs_agent(job):
                continue
            checked += 1
            errors.extend(check_job(path.name, job_id, job))
    if checked:
        errors.extend(check_policy())
    for error in errors:
        print(f"::error::{error}")
    if errors:
        return 1
    if checked == 0:
        print("OK: no workflow job runs the agent, so there was nothing to check.")
    else:
        print(f"OK: checked {checked} job(s) that run the agent and found no problems.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
