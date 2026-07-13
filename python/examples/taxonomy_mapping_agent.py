"""Agent that uses an org-managed taxonomy to remap a column of raw category values
to canonical ones, flagging anything it couldn't map.

Run:
    export Z3T_AGENT_KEY=...
    python examples/taxonomy_mapping_agent.py
"""

import asyncio
import os

from z3t_ai_agent import Agent, VersionSchema, s

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])

mapping_schema = VersionSchema(
    input=s.object(
        {
            "columnMapping": s.taxonomy_ref(title="Category mapping"),
            "rows": s.array(
                s.object({"rawCategory": s.string(title="Raw category")}),
                title="Rows",
            ),
        }
    ),
    output=s.object(
        {
            "rows": s.array(
                s.object(
                    {
                        "rawCategory": s.string(title="Raw category"),
                        "category": s.string(title="Mapped category"),
                    }
                ),
                layout="table",
                title="Mapped rows",
            ),
            "unmapped": s.array(
                s.object({"rawCategory": s.string(title="Raw category")}),
                title="Unmapped",
            ),
        }
    ),
)


@agent.handle(version=1, schema=mapping_schema)
async def handle(input: dict, ctx) -> dict:
    # input["columnMapping"] = "z3t://taxonomies/xyz789"
    entries = await ctx.taxonomies.entries(input["columnMapping"])
    lookup = {e["key"]: e["value"] for e in entries}

    transformed = [
        {**row, "category": lookup.get(row["rawCategory"], row["rawCategory"])} for row in input["rows"]
    ]
    unmapped = [row for row in input["rows"] if row["rawCategory"] not in lookup]

    return {"rows": transformed, "unmapped": unmapped}


if __name__ == "__main__":
    asyncio.run(agent.start())
