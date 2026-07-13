"""Minimal agent: a single version with the smallest useful schema. Downloads an input
file, asks an LLM to summarise it, and uploads a result file.

Every agent should declare at least one schema — it defines the buyer-facing form and
the output view, so without one there's no published contract buyers can call. This is
the smallest useful schema; see versioned_schema_agent.py for progress reporting,
optional fields, and enums.

Run:
    export Z3T_AGENT_KEY=...
    python examples/quickstart_default_handler.py
"""

import asyncio
import os

from z3t_ai_agent import Agent, VersionSchema, s

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])

summary_schema = VersionSchema(
    input=s.object({"document": s.file_uri(title="Document")}),
    output=s.object(
        {
            "summary": s.markdown(title="Summary"),
            "report": s.file_output(title="Summary file"),
        }
    ),
)


@agent.handle(version=1, schema=summary_schema)
async def handle(input: dict, ctx) -> dict:
    file = await ctx.files.download(input["document"])

    response = await ctx.llm.openai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": f"Summarise this document: {file.buffer[:2000]!r}"}],
    )
    summary = response.choices[0].message.content

    report_uri = await ctx.files.upload(summary.encode(), "summary.txt", "text/plain")

    return {
        "summary": summary,
        "report": report_uri,  # z3t://files/{id} — frontend renders a download button
    }


if __name__ == "__main__":
    asyncio.run(agent.start())
