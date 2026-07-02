"""Agent that resolves a stored integration credential and pushes data to an
external API with it (e.g. a CRM).

Run:
    export Z3T_AGENT_KEY=...
    python examples/integration_credentials_agent.py
"""

import asyncio
import os

import httpx

from z3t_ai_agent import Agent

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])


@agent.handle()
async def handle(input: dict, ctx) -> dict:
    # input["targetCRM"] = "z3t://integrations/abc123"  (Salesforce, api_key type)
    creds = await ctx.integrations.credentials(input["targetCRM"])

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.salesforce.com/...",
            headers={"Authorization": f"Bearer {creds['apiKey']}"},
            json=input["extractedData"],
        )
        resp.raise_for_status()

    return {"status": "pushed", "recordsCreated": len(input["extractedData"])}


if __name__ == "__main__":
    asyncio.run(agent.start())
