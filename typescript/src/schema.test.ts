import { describe, it, expect } from 'vitest'
import { s, SchemaField } from './schema'
import type { Infer, InferShape } from './schema'

describe('s.string()', () => {
  it('produces correct JSON Schema', () => {
    expect(s.string()._def).toEqual({ type: 'string' })
  })

  it('includes minLength, maxLength, pattern', () => {
    expect(s.string({ minLength: 2, maxLength: 50, pattern: '^[a-z]+$' })._def).toMatchObject({
      minLength: 2,
      maxLength: 50,
      pattern: '^[a-z]+$',
    })
  })

  it('sets x-z3t-display for textarea and markdown', () => {
    expect(s.string({ display: 'textarea' })._def['x-z3t-display']).toBe('textarea')
    expect(s.string({ display: 'markdown' })._def['x-z3t-display']).toBe('markdown')
  })

  it('sets x-z3t-code-language when display=code', () => {
    expect(s.string({ display: 'code', language: 'sql' })._def).toMatchObject({
      'x-z3t-display': 'code',
      'x-z3t-code-language': 'sql',
    })
  })
})

describe('s.email() / s.url()', () => {
  it('sets format: email', () => {
    expect(s.email()._def).toMatchObject({ type: 'string', format: 'email' })
  })

  it('sets format: uri', () => {
    expect(s.url()._def).toMatchObject({ type: 'string', format: 'uri' })
  })
})

describe('s.number() / s.integer()', () => {
  it('includes min, max, multipleOf as minimum/maximum/multipleOf', () => {
    expect(s.number({ min: 0, max: 100, multipleOf: 5 })._def).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 100,
      multipleOf: 5,
    })
  })

  it('sets x-z3t-display: range for slider', () => {
    expect(s.integer({ display: 'slider', min: 1, max: 10 })._def['x-z3t-display']).toBe('range')
  })
})

describe('s.boolean()', () => {
  it('produces type: boolean', () => {
    expect(s.boolean()._def).toEqual({ type: 'boolean' })
  })

  it('sets x-z3t-display: toggle', () => {
    expect(s.boolean({ display: 'toggle' })._def['x-z3t-display']).toBe('toggle')
  })
})

describe('s.enum()', () => {
  it('produces string enum', () => {
    expect(s.enum(['en', 'fr', 'de'] as const)._def).toMatchObject({
      type: 'string',
      enum: ['en', 'fr', 'de'],
    })
  })

  it('sets x-z3t-display: radio', () => {
    expect(s.enum(['a', 'b'] as const, { display: 'radio' })._def['x-z3t-display']).toBe('radio')
  })

  it('sets x-z3t-color-map', () => {
    const colorMap = { ACTIVE: 'green', INACTIVE: 'red' }
    expect(s.enum(['ACTIVE', 'INACTIVE'] as const, { colorMap })._def['x-z3t-color-map']).toEqual(colorMap)
  })
})

describe('s.object()', () => {
  it('produces object schema with properties and required array', () => {
    const schema = s.object({
      name: s.string({ title: 'Name' }),
      age: s.integer().optional(),
    })

    expect(schema._def).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        age: { type: 'integer' },
      },
      required: ['name'],
    })
    // 'age' is optional — not in required
    expect((schema._def.required as string[])).not.toContain('age')
  })

  it('omits required array when all fields are optional', () => {
    const schema = s.object({ a: s.string().optional() })
    expect(schema._def).not.toHaveProperty('required')
  })

  it('includes all required fields in required array', () => {
    const schema = s.object({ a: s.string(), b: s.number(), c: s.boolean() })
    expect(schema._def.required).toEqual(expect.arrayContaining(['a', 'b', 'c']))
  })
})

describe('s.array()', () => {
  it('produces array schema with items', () => {
    expect(s.array(s.string())._def).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    })
  })

  it('includes minItems and maxItems', () => {
    expect(s.array(s.fileUri(), { minItems: 1, maxItems: 5 })._def).toMatchObject({
      minItems: 1,
      maxItems: 5,
    })
  })

  it('adds format: z3t-file-list when items are fileOutput', () => {
    expect(s.array(s.fileOutput())._def.format).toBe('z3t-file-list')
  })

  it('adds format: table when display=table', () => {
    expect(s.array(s.object({ a: s.string() }), { display: 'table' })._def.format).toBe('table')
  })

  it('adds sortable/searchable flags', () => {
    const def = s.array(s.object({ a: s.string() }), { display: 'table', sortable: true, searchable: true })._def
    expect(def['x-z3t-table-sortable']).toBe(true)
    expect(def['x-z3t-table-searchable']).toBe(true)
  })
})

describe('s.fileUri()', () => {
  it('produces z3t-file-uri format', () => {
    expect(s.fileUri()._def).toMatchObject({ type: 'string', format: 'z3t-file-uri' })
  })

  it('includes accept and maxSizeMb', () => {
    const f = s.fileUri({ accept: ['application/pdf', 'image/*'], maxSizeMb: 10 })
    expect(f._def['x-z3t-accept']).toEqual(['application/pdf', 'image/*'])
    expect(f._def['x-z3t-max-size-mb']).toBe(10)
  })
})

describe('s.taxonomyRef() / s.integrationRef()', () => {
  it('taxonomyRef sets format and optional slug', () => {
    const f = s.taxonomyRef({ taxonomySlug: 'my-taxonomy' })
    expect(f._def).toMatchObject({ format: 'z3t-taxonomy-ref', 'x-z3t-taxonomy-slug': 'my-taxonomy' })
  })

  it('integrationRef sets format and optional provider', () => {
    const f = s.integrationRef({ provider: 'salesforce' })
    expect(f._def).toMatchObject({ format: 'z3t-integration-ref', 'x-z3t-integration-provider': 'salesforce' })
  })
})

describe('s.markdown() / s.html() / s.code() / s.json() / s.image()', () => {
  it.each([
    ['markdown', s.markdown()],
    ['html', s.html()],
    ['json', s.json()],
    ['image', s.image()],
  ])('%s sets correct format', (format, f) => {
    expect(f._def.format).toBe(format)
  })

  it('code sets x-z3t-code-language', () => {
    expect(s.code({ language: 'python' })._def).toMatchObject({ format: 'code', 'x-z3t-code-language': 'python' })
  })
})

describe('s.percent() / s.fileOutput()', () => {
  it('percent is type: number with format: percent', () => {
    expect(s.percent()._def).toMatchObject({ type: 'number', format: 'percent' })
  })

  it('fileOutput is type: string with format: z3t-file-output', () => {
    expect(s.fileOutput()._def).toMatchObject({ type: 'string', format: 'z3t-file-output' })
  })
})

describe('optional()', () => {
  it('sets _optional = true', () => {
    expect(s.string()._optional).toBe(false)
    expect(s.string().optional()._optional).toBe(true)
  })

  it('preserves the original _def', () => {
    const f = s.number({ min: 5, max: 10 })
    const opt = f.optional()
    expect(opt._def).toEqual(f._def)
  })
})

describe('metadata', () => {
  it('includes title, description, hint, order, group', () => {
    const f = s.string({ title: 'T', description: 'D', hint: 'H', order: 3, group: 'G' })
    expect(f._def).toMatchObject({
      title: 'T',
      description: 'D',
      'x-z3t-hint': 'H',
      'x-z3t-order': 3,
      'x-z3t-group': 'G',
    })
  })
})

describe('TypeScript inference (compile-time only)', () => {
  it('infers correct types from s.object()', () => {
    const schema = s.object({
      doc: s.fileUri(),
      lang: s.enum(['en', 'fr'] as const),
      notes: s.string().optional(),
    })

    type T = Infer<typeof schema>
    // Compile-time check — if this compiles, inference is correct
    const _check: T = { doc: 'z3t://files/x', lang: 'en' }
    const _checkOptional: T = { doc: 'z3t://files/x', lang: 'fr', notes: 'hi' }
    expect(_check).toBeTruthy()
    expect(_checkOptional).toBeTruthy()
  })

  it('infers array types', () => {
    const arr = s.array(s.fileUri())
    type T = Infer<typeof arr>
    const _check: T = ['z3t://files/a', 'z3t://files/b']
    expect(_check).toBeTruthy()
  })
})
