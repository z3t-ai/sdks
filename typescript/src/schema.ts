// ─── Phantom type infrastructure ───────────────────────────────────────────

const _type = Symbol('z3t.type')

export class SchemaField<T> {
  readonly [_type]!: T // phantom — declared but never assigned at runtime

  constructor(
    readonly _def: Record<string, unknown>,
    readonly _optional: boolean = false,
  ) {}

  /** Mark this field as optional. The handler's input type will reflect the field as `T | undefined`. */
  optional(): SchemaField<T | undefined> {
    return new SchemaField<T | undefined>(this._def, true)
  }
}

// ─── TypeScript inference helpers ──────────────────────────────────────────

/** Extract the TypeScript type from a SchemaField */
export type Infer<F extends SchemaField<unknown>> = F[typeof _type]

type RequiredKeys<T extends Record<string, SchemaField<unknown>>> = {
  [K in keyof T]: undefined extends T[K][typeof _type] ? never : K
}[keyof T]

type OptionalKeys<T extends Record<string, SchemaField<unknown>>> = {
  [K in keyof T]: undefined extends T[K][typeof _type] ? K : never
}[keyof T]

/** Infer the TypeScript object type from a shape record produced by s.object() */
export type InferShape<T extends Record<string, SchemaField<unknown>>> =
  { [K in RequiredKeys<T>]: Exclude<T[K][typeof _type], undefined> } &
  { [K in OptionalKeys<T>]?: Exclude<T[K][typeof _type], undefined> }

// ─── Options interfaces ────────────────────────────────────────────────────

interface BaseOptions {
  title?: string
  description?: string
  /** Short inline helper text shown below the field */
  hint?: string
  /** Explicit sort order within the form */
  order?: number
  /** Visual grouping label for adjacent fields */
  group?: string
}

interface StringOptions extends BaseOptions {
  display?: 'textarea' | 'markdown' | 'code' | 'hidden'
  language?: string // syntax highlight language when display = 'code'
  minLength?: number
  maxLength?: number
  pattern?: string
}

interface NumberOptions extends BaseOptions {
  display?: 'slider'
  min?: number
  max?: number
  multipleOf?: number
}

interface DateOptions extends BaseOptions {
  min?: string
  max?: string
}

interface BooleanOptions extends BaseOptions {
  display?: 'toggle'
}

interface EnumOptions extends BaseOptions {
  display?: 'radio'
  /** Map enum values to badge colours for output rendering: { ACTIVE: 'green', INACTIVE: 'red' } */
  colorMap?: Record<string, string>
}

interface ArrayOptions extends BaseOptions {
  minItems?: number
  maxItems?: number
  /** Render array-of-object output as a sortable table or source-reference list */
  display?: 'table'
  sortable?: boolean
  searchable?: boolean
}

interface FileUriOptions extends BaseOptions {
  /** Accepted MIME types, e.g. ['application/pdf', 'image/*'] */
  accept?: string[]
  /** Maximum file size hint shown in UI (MB) */
  maxSizeMb?: number
}

interface TaxonomyRefOptions extends BaseOptions {
  /** Pre-select a specific taxonomy by slug */
  taxonomySlug?: string
}

interface IntegrationRefOptions extends BaseOptions {
  /** Filter integration dropdown to a specific provider key */
  provider?: string
}

interface CodeOptions extends BaseOptions {
  /** Syntax highlight language for output code blocks */
  language?: string
}

// ─── PdfReference ────────────────────────────────────────────────────────────

export interface PdfReference {
  format: 'pdf-reference'
  file: string
  page?: number
  hint?: string
}

export const PdfReference = {
  create(opts: { file: string; page?: number; hint?: string }): PdfReference {
    const ref: PdfReference = { format: 'pdf-reference', file: opts.file }
    if (opts.page !== undefined) ref.page = opts.page
    if (opts.hint !== undefined) ref.hint = opts.hint
    return ref
  },
}

// ─── TypedValue ───────────────────────────────────────────────────────────────

export type TypedValueFormat = 'text' | 'markdown' | 'number' | 'date' | 'boolean' | 'enum'

export interface TypedValue {
  format: TypedValueFormat
  value: string
}

export const TypedValue = {
  text:     (value: string): TypedValue => ({ format: 'text',     value }),
  markdown: (value: string): TypedValue => ({ format: 'markdown', value }),
  number:   (value: string): TypedValue => ({ format: 'number',   value }),
  date:     (value: string): TypedValue => ({ format: 'date',     value }),
  boolean:  (value: string): TypedValue => ({ format: 'boolean',  value }),
  enum:     (value: string): TypedValue => ({ format: 'enum',     value }),
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function meta(opts: BaseOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (opts.title !== undefined) out.title = opts.title
  if (opts.description !== undefined) out.description = opts.description
  if (opts.hint !== undefined) out['x-z3t-hint'] = opts.hint
  if (opts.order !== undefined) out['x-z3t-order'] = opts.order
  if (opts.group !== undefined) out['x-z3t-group'] = opts.group
  return out
}

function field<T>(def: Record<string, unknown>, optional = false): SchemaField<T> {
  return new SchemaField<T>(def, optional)
}

// ─── Schema builder ────────────────────────────────────────────────────────

export const s = {
  // ── Primitive text types ──────────────────────────────────────────────

  string(opts: StringOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = { type: 'string', ...meta(opts) }
    if (opts.display) def['x-z3t-display'] = opts.display
    if (opts.language) def['x-z3t-code-language'] = opts.language
    if (opts.minLength !== undefined) def.minLength = opts.minLength
    if (opts.maxLength !== undefined) def.maxLength = opts.maxLength
    if (opts.pattern) def.pattern = opts.pattern
    return field<string>(def)
  },

  email(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'email', ...meta(opts) })
  },

  url(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'uri', ...meta(opts) })
  },

  date(opts: DateOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = { type: 'string', format: 'date', ...meta(opts) }
    if (opts.min) def['x-z3t-min'] = opts.min
    if (opts.max) def['x-z3t-max'] = opts.max
    return field<string>(def)
  },

  datetime(opts: DateOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = { type: 'string', format: 'date-time', ...meta(opts) }
    if (opts.min) def['x-z3t-min'] = opts.min
    if (opts.max) def['x-z3t-max'] = opts.max
    return field<string>(def)
  },

  // ── Numeric types ─────────────────────────────────────────────────────

  number(opts: NumberOptions = {}): SchemaField<number> {
    const def: Record<string, unknown> = { type: 'number', ...meta(opts) }
    if (opts.display === 'slider') def['x-z3t-display'] = 'range'
    if (opts.min !== undefined) def.minimum = opts.min
    if (opts.max !== undefined) def.maximum = opts.max
    if (opts.multipleOf !== undefined) def.multipleOf = opts.multipleOf
    return field<number>(def)
  },

  integer(opts: NumberOptions = {}): SchemaField<number> {
    const def: Record<string, unknown> = { type: 'integer', ...meta(opts) }
    if (opts.display === 'slider') def['x-z3t-display'] = 'range'
    if (opts.min !== undefined) def.minimum = opts.min
    if (opts.max !== undefined) def.maximum = opts.max
    if (opts.multipleOf !== undefined) def.multipleOf = opts.multipleOf
    return field<number>(def)
  },

  // ── Boolean ──────────────────────────────────────────────────────────

  boolean(opts: BooleanOptions = {}): SchemaField<boolean> {
    const def: Record<string, unknown> = { type: 'boolean', ...meta(opts) }
    if (opts.display === 'toggle') def['x-z3t-display'] = 'toggle'
    return field<boolean>(def)
  },

  // ── Selection ────────────────────────────────────────────────────────

  enum<T extends string>(values: readonly [T, ...T[]], opts: EnumOptions = {}): SchemaField<T> {
    const def: Record<string, unknown> = { type: 'string', enum: [...values], ...meta(opts) }
    if (opts.display === 'radio') def['x-z3t-display'] = 'radio'
    if (opts.colorMap) def['x-z3t-color-map'] = opts.colorMap
    return field<T>(def)
  },

  // ── Composite ────────────────────────────────────────────────────────

  object<T extends Record<string, SchemaField<unknown>>>(
    shape: T,
    opts: BaseOptions = {},
  ): SchemaField<InferShape<T>> {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, f] of Object.entries(shape)) {
      properties[key] = f._def
      if (!f._optional) required.push(key)
    }

    const def: Record<string, unknown> = { type: 'object', properties, ...meta(opts) }
    if (required.length > 0) def.required = required

    return field<InferShape<T>>(def)
  },

  array<T>(item: SchemaField<T>, opts: ArrayOptions = {}): SchemaField<Exclude<T, undefined>[]> {
    const def: Record<string, unknown> = { type: 'array', items: item._def, ...meta(opts) }
    if (opts.minItems !== undefined) def.minItems = opts.minItems
    if (opts.maxItems !== undefined) def.maxItems = opts.maxItems

    // Output: array of file downloads → z3t-file-list format
    if (item._def['format'] === 'z3t-file-output') def.format = 'z3t-file-list'
    // Output: array of objects → table format or source-reference list
    if (opts.display === 'table') def.format = 'table'
if (opts.sortable) def['x-z3t-table-sortable'] = true
    if (opts.searchable) def['x-z3t-table-searchable'] = true

    return field<Exclude<T, undefined>[]>(def)
  },

  // ── z3t platform input types ─────────────────────────────────────────

  /** File upload — stores to DO Spaces, resolves to z3t://files/{id} in the agent */
  fileUri(opts: FileUriOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = { type: 'string', format: 'z3t-file-uri', ...meta(opts) }
    if (opts.accept) def['x-z3t-accept'] = opts.accept
    if (opts.maxSizeMb !== undefined) def['x-z3t-max-size-mb'] = opts.maxSizeMb
    return field<string>(def)
  },

  /** Dropdown of org's taxonomies — resolves to z3t://taxonomies/{id} */
  taxonomyRef(opts: TaxonomyRefOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = {
      type: 'string',
      format: 'z3t-taxonomy-ref',
      ...meta(opts),
    }
    if (opts.taxonomySlug) def['x-z3t-taxonomy-slug'] = opts.taxonomySlug
    return field<string>(def)
  },

  /** Dropdown of org's integrations — resolves to z3t://integrations/{id} */
  integrationRef(opts: IntegrationRefOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = {
      type: 'string',
      format: 'z3t-integration-ref',
      ...meta(opts),
    }
    if (opts.provider) def['x-z3t-integration-provider'] = opts.provider
    return field<string>(def)
  },

  // ── z3t platform output types ─────────────────────────────────────────

  /** Output rendered as Markdown */
  markdown(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'markdown', ...meta(opts) })
  },

  /** Output rendered as sanitized HTML */
  html(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'html', ...meta(opts) })
  },

  /** Output rendered as a syntax-highlighted code block */
  code(opts: CodeOptions = {}): SchemaField<string> {
    const def: Record<string, unknown> = { type: 'string', format: 'code', ...meta(opts) }
    if (opts.language) def['x-z3t-code-language'] = opts.language
    return field<string>(def)
  },

  /** Output rendered as a syntax-highlighted JSON block */
  json(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'json', ...meta(opts) })
  },

  /** Output rendered as an inline image */
  image(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'image', ...meta(opts) })
  },

  /** Output rendered as a percentage bar (value must be 0–1) */
  percent(opts: BaseOptions = {}): SchemaField<number> {
    return field<number>({ type: 'number', format: 'percent', ...meta(opts) })
  },

  /** Agent-produced file — rendered as a download button */
  fileOutput(opts: BaseOptions = {}): SchemaField<string> {
    return field<string>({ type: 'string', format: 'z3t-file-output', ...meta(opts) })
  },

  /** PDF source reference — rendered as a clickable chip that opens a PDF preview modal.
   *  Use PdfReference.create({ file, page?, hint? }) to construct values at runtime. */
  pdfReference(opts: BaseOptions = {}): SchemaField<PdfReference> {
    return field<PdfReference>({
      type: 'object',
      properties: {
        format: { type: 'string', const: 'pdf-reference' },
        file:   { type: 'string', format: 'z3t-file-uri' },
        page:   { type: 'integer' },
        hint:   { type: 'string' },
      },
      required: ['format', 'file'],
      'x-z3t-display': 'pdf-reference',
      ...meta(opts),
    })
  },

  /** Self-describing typed value — rendered by the frontend based on { format, value }.
   *  Use TypedValue.markdown(str), TypedValue.number(str) etc. to construct values at runtime. */
  typedValue(opts: BaseOptions = {}): SchemaField<TypedValue> {
    const def: Record<string, unknown> = {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['text', 'markdown', 'number', 'date', 'boolean', 'enum'] },
        value:  { type: 'string' },
      },
      required: ['format', 'value'],
      'x-z3t-display': 'typed-value',
      ...meta(opts),
    }
    return field<TypedValue>(def)
  },
}

// ─── Version schema ────────────────────────────────────────────────────────

export interface VersionSchema<I = unknown, O = unknown> {
  input: SchemaField<I>
  output: SchemaField<O>
  /** Publish status synced to the platform. Default: 'draft' — mutable, invisible to consumers,
   *  freely edited across restarts. Set to 'active' once ready to publish; from then on the
   *  schema is immutable and changing it will fail schema-sync. */
  status?: 'draft' | 'active'
  /** Previous version numbers this version replaces. Those versions will be deprecated on agent.start(). */
  deprecates?: number[]
  /** Human-readable migration note shown to consumers of deprecated versions */
  deprecationNotice?: string
}
