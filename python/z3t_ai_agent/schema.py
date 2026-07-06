from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Sequence, TypedDict, TypeVar

T = TypeVar("T")

# ─── Schema field wrapper ───────────────────────────────────────────────────


class SchemaField(Generic[T]):
    """Wraps a JSON Schema fragment (`_def`) produced by the `s.*` builder.

    The generic parameter is for type-checker/IDE assistance only — Python has
    no runtime use for it, unlike the phantom-type trick the TypeScript builder
    uses for the same purpose.
    """

    __slots__ = ("_def", "_optional")

    def __init__(self, _def: dict[str, Any], _optional: bool = False) -> None:
        self._def = _def
        self._optional = _optional

    def optional(self) -> "SchemaField[T | None]":
        """Mark this field as optional — removes it from the parent object's `required` list."""
        return SchemaField(self._def, True)


def _meta(
    *,
    title: str | None = None,
    description: str | None = None,
    hint: str | None = None,
    order: int | None = None,
    group: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if title is not None:
        out["title"] = title
    if description is not None:
        out["description"] = description
    if hint is not None:
        out["x-z3t-hint"] = hint
    if order is not None:
        out["x-z3t-order"] = order
    if group is not None:
        out["x-z3t-group"] = group
    return out


# ─── Schema builder ─────────────────────────────────────────────────────────


class _SchemaBuilder:
    """Every field is **required by default**. Call `.optional()` to make it optional."""

    # ── Primitive text types ────────────────────────────────────────────

    def string(
        self,
        *,
        display: Literal["textarea", "markdown", "code", "hidden"] | None = None,
        language: str | None = None,
        min_length: int | None = None,
        max_length: int | None = None,
        pattern: str | None = None,
        title: str | None = None,
        description: str | None = None,
        hint: str | None = None,
        order: int | None = None,
        group: str | None = None,
    ) -> SchemaField[str]:
        d: dict[str, Any] = {
            "type": "string",
            **_meta(title=title, description=description, hint=hint, order=order, group=group),
        }
        if display:
            d["x-z3t-display"] = display
        if language:
            d["x-z3t-code-language"] = language
        if min_length is not None:
            d["minLength"] = min_length
        if max_length is not None:
            d["maxLength"] = max_length
        if pattern:
            d["pattern"] = pattern
        return SchemaField(d)

    def email(self, **opts: Any) -> SchemaField[str]:
        return SchemaField({"type": "string", "format": "email", **_meta(**opts)})

    def url(self, **opts: Any) -> SchemaField[str]:
        return SchemaField({"type": "string", "format": "uri", **_meta(**opts)})

    def date(self, *, min: str | None = None, max: str | None = None, **opts: Any) -> SchemaField[str]:
        d: dict[str, Any] = {"type": "string", "format": "date", **_meta(**opts)}
        if min:
            d["x-z3t-min"] = min
        if max:
            d["x-z3t-max"] = max
        return SchemaField(d)

    def datetime(self, *, min: str | None = None, max: str | None = None, **opts: Any) -> SchemaField[str]:
        d: dict[str, Any] = {"type": "string", "format": "date-time", **_meta(**opts)}
        if min:
            d["x-z3t-min"] = min
        if max:
            d["x-z3t-max"] = max
        return SchemaField(d)

    # ── Numeric types ───────────────────────────────────────────────────

    def number(
        self,
        *,
        display: Literal["slider"] | None = None,
        min: float | None = None,
        max: float | None = None,
        multiple_of: float | None = None,
        **opts: Any,
    ) -> SchemaField[float]:
        d: dict[str, Any] = {"type": "number", **_meta(**opts)}
        if display == "slider":
            d["x-z3t-display"] = "range"
        if min is not None:
            d["minimum"] = min
        if max is not None:
            d["maximum"] = max
        if multiple_of is not None:
            d["multipleOf"] = multiple_of
        return SchemaField(d)

    def integer(
        self,
        *,
        display: Literal["slider"] | None = None,
        min: int | None = None,
        max: int | None = None,
        multiple_of: int | None = None,
        **opts: Any,
    ) -> SchemaField[int]:
        d: dict[str, Any] = {"type": "integer", **_meta(**opts)}
        if display == "slider":
            d["x-z3t-display"] = "range"
        if min is not None:
            d["minimum"] = min
        if max is not None:
            d["maximum"] = max
        if multiple_of is not None:
            d["multipleOf"] = multiple_of
        return SchemaField(d)

    # ── Boolean ──────────────────────────────────────────────────────────

    def boolean(self, *, display: Literal["toggle"] | None = None, **opts: Any) -> SchemaField[bool]:
        d: dict[str, Any] = {"type": "boolean", **_meta(**opts)}
        if display == "toggle":
            d["x-z3t-display"] = "toggle"
        return SchemaField(d)

    # ── Selection ────────────────────────────────────────────────────────

    def enum(
        self,
        values: Sequence[str],
        *,
        display: Literal["radio"] | None = None,
        color_map: dict[str, str] | None = None,
        **opts: Any,
    ) -> SchemaField[str]:
        d: dict[str, Any] = {"type": "string", "enum": list(values), **_meta(**opts)}
        if display == "radio":
            d["x-z3t-display"] = "radio"
        if color_map:
            d["x-z3t-color-map"] = color_map
        return SchemaField(d)

    # ── Composite ────────────────────────────────────────────────────────

    def object(self, shape: dict[str, SchemaField[Any]], **opts: Any) -> SchemaField[dict[str, Any]]:
        properties: dict[str, Any] = {}
        required: list[str] = []
        for key, f in shape.items():
            properties[key] = f._def
            if not f._optional:
                required.append(key)

        d: dict[str, Any] = {"type": "object", "properties": properties, **_meta(**opts)}
        if required:
            d["required"] = required
        return SchemaField(d)

    def array(
        self,
        item: SchemaField[Any],
        *,
        layout: Literal["table", "list", "grid", "gallery"] | None = None,
        min_items: int | None = None,
        max_items: int | None = None,
        sortable: bool | None = None,
        searchable: bool | None = None,
        **opts: Any,
    ) -> SchemaField[list[Any]]:
        d: dict[str, Any] = {"type": "array", "items": item._def, **_meta(**opts)}
        if min_items is not None:
            d["minItems"] = min_items
        if max_items is not None:
            d["maxItems"] = max_items

        if item._def.get("x-z3t-display") == "file-output":
            d["x-z3t-layout"] = {"type": "file-list"}
        elif layout == "table":
            layout_def: dict[str, Any] = {"type": "table"}
            if sortable:
                layout_def["sortable"] = True
            if searchable:
                layout_def["searchable"] = True
            d["x-z3t-layout"] = layout_def
        elif layout:
            d["x-z3t-layout"] = {"type": layout}

        return SchemaField(d)

    # ── z3t platform input types ─────────────────────────────────────────

    def file_uri(
        self,
        *,
        accept: Sequence[str] | None = None,
        max_size_mb: float | None = None,
        **opts: Any,
    ) -> SchemaField[str]:
        """File upload — stores to DO Spaces, resolves to z3t://files/{id} in the agent."""
        d: dict[str, Any] = {"type": "string", "format": "z3t-file-uri", **_meta(**opts)}
        if accept:
            d["x-z3t-accept"] = list(accept)
        if max_size_mb is not None:
            d["x-z3t-max-size-mb"] = max_size_mb
        return SchemaField(d)

    def taxonomy_ref(self, *, taxonomy_slug: str | None = None, **opts: Any) -> SchemaField[str]:
        """Dropdown of org's taxonomies — resolves to z3t://taxonomies/{id}."""
        d: dict[str, Any] = {"type": "string", "format": "z3t-taxonomy-ref", **_meta(**opts)}
        if taxonomy_slug:
            d["x-z3t-taxonomy-slug"] = taxonomy_slug
        return SchemaField(d)

    def integration_ref(self, *, provider: str | None = None, **opts: Any) -> SchemaField[str]:
        """Dropdown of org's integrations — resolves to z3t://integrations/{id}."""
        d: dict[str, Any] = {"type": "string", "format": "z3t-integration-ref", **_meta(**opts)}
        if provider:
            d["x-z3t-integration-provider"] = provider
        return SchemaField(d)

    # ── z3t platform output types ─────────────────────────────────────────

    def markdown(self, **opts: Any) -> SchemaField[str]:
        return SchemaField({"type": "string", "x-z3t-display": "markdown", **_meta(**opts)})

    def html(self, **opts: Any) -> SchemaField[str]:
        return SchemaField({"type": "string", "x-z3t-display": "html", **_meta(**opts)})

    def code(self, *, language: str | None = None, **opts: Any) -> SchemaField[str]:
        d: dict[str, Any] = {"type": "string", "x-z3t-display": "code", **_meta(**opts)}
        if language:
            d["x-z3t-code-language"] = language
        return SchemaField(d)

    def json(self, **opts: Any) -> SchemaField[str]:
        return SchemaField({"type": "string", "x-z3t-display": "json", **_meta(**opts)})

    def image(self, **opts: Any) -> SchemaField[str]:
        return SchemaField({"type": "string", "x-z3t-display": "image", **_meta(**opts)})

    def percent(self, **opts: Any) -> SchemaField[float]:
        """Output rendered as a percentage bar (value must be 0–1)."""
        return SchemaField({"type": "number", "x-z3t-display": "percent", **_meta(**opts)})

    def file_output(self, **opts: Any) -> SchemaField[str]:
        """Agent-produced file — rendered as a download button."""
        return SchemaField({"type": "string", "x-z3t-display": "file-output", **_meta(**opts)})

    def pdf_reference(self, **opts: Any) -> "SchemaField[PdfReference]":
        """PDF source reference — rendered as a clickable chip that opens a PDF preview modal.
        Use `pdf_reference()` (the module-level function) to construct values at runtime."""
        return SchemaField(
            {
                "type": "object",
                "properties": {
                    "format": {"type": "string", "const": "pdf-reference"},
                    "file": {"type": "string", "format": "z3t-file-uri"},
                    "page": {"type": "integer"},
                    "hint": {"type": "string"},
                },
                "required": ["format", "file"],
                "x-z3t-display": "pdf-reference",
                **_meta(**opts),
            }
        )

    def typed_value(self, **opts: Any) -> "SchemaField[TypedValue]":
        """Self-describing typed value — rendered by the frontend based on {format, value}.
        Use the `typed_value` namespace (e.g. `typed_value.markdown(str)`) to construct values."""
        return SchemaField(
            {
                "type": "object",
                "properties": {
                    "format": {
                        "type": "string",
                        "enum": ["text", "markdown", "number", "date", "boolean", "enum"],
                    },
                    "value": {"type": "string"},
                },
                "required": ["format", "value"],
                "x-z3t-display": "typed-value",
                **_meta(**opts),
            }
        )


s = _SchemaBuilder()


# ─── PdfReference ────────────────────────────────────────────────────────────


class PdfReference(TypedDict, total=False):
    format: Literal["pdf-reference"]
    file: str
    page: int
    hint: str


def pdf_reference(file: str, *, page: int | None = None, hint: str | None = None) -> PdfReference:
    ref: PdfReference = {"format": "pdf-reference", "file": file}
    if page is not None:
        ref["page"] = page
    if hint is not None:
        ref["hint"] = hint
    return ref


# ─── TypedValue ──────────────────────────────────────────────────────────────

TypedValueFormat = Literal["text", "markdown", "number", "date", "boolean", "enum"]


class TypedValue(TypedDict):
    format: TypedValueFormat
    value: str


class _TypedValueNamespace:
    @staticmethod
    def text(value: str) -> TypedValue:
        return {"format": "text", "value": value}

    @staticmethod
    def markdown(value: str) -> TypedValue:
        return {"format": "markdown", "value": value}

    @staticmethod
    def number(value: str) -> TypedValue:
        return {"format": "number", "value": value}

    @staticmethod
    def date(value: str) -> TypedValue:
        return {"format": "date", "value": value}

    @staticmethod
    def boolean(value: str) -> TypedValue:
        return {"format": "boolean", "value": value}

    @staticmethod
    def enum(value: str) -> TypedValue:
        return {"format": "enum", "value": value}


typed_value = _TypedValueNamespace()


# ─── Version schema ──────────────────────────────────────────────────────────


@dataclass
class VersionSchema:
    input: SchemaField[Any]
    output: SchemaField[Any]
    # Publish status synced to the platform. Default: 'draft' — mutable, invisible to
    # consumers, freely edited across restarts. Set to 'active' once ready to publish;
    # from then on the schema is immutable and changing it will fail schema-sync.
    status: Literal["draft", "active"] = "draft"
    # Previous version numbers this version replaces. Deprecated on agent.start().
    deprecates: list[int] | None = None
    # Human-readable migration note shown to consumers of deprecated versions.
    deprecation_notice: str | None = None
