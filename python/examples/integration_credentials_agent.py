"""Agent that resolves a stored integration credential and pushes data to an
external API with it (e.g. a CRM).

⚠️  The integrations credentials vault is COMING SOON — not yet available.
    `s.integration_ref()` and `ctx.integrations.credentials()` are part of the SDK
    surface, but the platform feature that backs them isn't live yet. This example is
    here so you can see the shape ahead of time; it won't resolve real credentials
    until the vault ships.

Run (once the vault is available):
    export Z3T_AGENT_KEY=...
    python examples/integration_credentials_agent.py
"""

import asyncio
import os

import httpx

from z3t_ai_agent import Agent, VersionSchema, s

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])

push_schema = VersionSchema(
    input=s.object(
        {
            "targetCRM": s.integration_ref(title="Target CRM"),
            "records": s.array(
                s.object({"name": s.string(title="Name")}),
                title="Records to push",
            ),
        }
    ),
    output=s.object(
        {
            "status": s.string(title="Status"),
            "recordsCreated": s.integer(title="Records created"),
        }
    ),
)


@agent.handle(version=1, schema=push_schema)
async def handle(input: dict, ctx) -> dict:
    # input["targetCRM"] = "z3t://integrations/abc123"  (Salesforce, api_key type)
    creds = await ctx.integrations.credentials(input["targetCRM"])

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.salesforce.com/...",
            headers={"Authorization": f"Bearer {creds['apiKey']}"},
            json=input["records"],
        )
        resp.raise_for_status()

    return {"status": "pushed", "recordsCreated": len(input["records"])}


if __name__ == "__main__":
    asyncio.run(agent.start())
