"""Minimal agent: one default handler, no declared schema (managed via the dashboard
instead). Downloads an input file, asks an LLM to summarise it, uploads a result file.

Run:
    export Z3T_AGENT_KEY=...
    python examples/quickstart_default_handler.py
"""

import asyncio
import os

from z3t_ai_agent import Agent

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])


@agent.handle()
async def handle(input: dict, ctx) -> dict:
    file = await ctx.files.download(input["documentUrl"])

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
