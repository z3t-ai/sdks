"""Versioned handler with a declared input/output schema (s.*). The schema syncs to
the platform on agent.start() and drives the frontend's form rendering and output
display. Demonstrates progress reporting, file download/upload, and an LLM call.

Run:
    export Z3T_AGENT_KEY=...
    python examples/versioned_schema_agent.py
"""

import asyncio
import os

from z3t_ai_agent import Agent, VersionSchema, s

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])

contract_schema_v1 = VersionSchema(
    input=s.object(
        {
            "document": s.file_uri(title="Contract PDF", accept=["application/pdf"]),
            "language": s.enum(["en", "fr", "de"], title="Language"),
            "notes": s.string(display="textarea", title="Notes").optional(),
        }
    ),
    output=s.object(
        {
            "summary": s.markdown(title="Summary"),
            "confidence": s.percent(title="Confidence"),
            "report": s.file_output(title="Full PDF report"),
        }
    ),
    status="draft",  # flip to "active" once you're ready to publish this version
)


@agent.handle(version=1, schema=contract_schema_v1)
async def handle_v1(input: dict, ctx) -> dict:
    await ctx.progress("downloading", "Downloading contract...", 0.1)
    contract = await ctx.files.download(input["document"])

    await ctx.progress("analysing", "Analysing with AI...", 0.4)
    response = await ctx.llm.anthropic.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": f"Summarise this contract in {input['language']}: "
                f"{contract.buffer[:4000]!r}",
            }
        ],
    )
    summary = response.content[0].text

    await ctx.progress("uploading", "Generating report...", 0.8)
    report_uri = await ctx.files.upload(summary.encode(), "report.pdf", "application/pdf")

    return {
        "summary": summary,
        "confidence": 0.92,
        "report": report_uri,
    }


if __name__ == "__main__":
    asyncio.run(agent.start())
