from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("z3t-ai-agent-sdk")
except PackageNotFoundError:
    __version__ = "0.0.0"

from .agent import Agent, Handler
from .context import CallContext, DownloadResult
from .schema import (
    PdfReference,
    SchemaField,
    TypedValue,
    TypedValueFormat,
    VersionSchema,
    pdf_reference,
    s,
    typed_value,
)
from .types import ConsoleLogger, Logger, TaxonomyEntry

__all__ = [
    "__version__",
    "Agent",
    "Handler",
    "CallContext",
    "DownloadResult",
    "s",
    "typed_value",
    "pdf_reference",
    "SchemaField",
    "VersionSchema",
    "PdfReference",
    "TypedValue",
    "TypedValueFormat",
    "TaxonomyEntry",
    "Logger",
    "ConsoleLogger",
]
