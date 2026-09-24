import { test, expect } from 'vitest'
import { denullify, applyRequiredHeaderFixups, REQUIRED_HEADER_FIXUPS } from './openapi-normalize.mjs'

test('denullify widens a plain nullable type into a type array and drops nullable', () => {
  expect(denullify({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] })
})

test('denullify keeps sibling keywords like format and description', () => {
  expect(denullify({ format: 'uuid', nullable: true, type: 'string' }))
    .toEqual({ format: 'uuid', type: ['string', 'null'] })
  expect(denullify({ description: 'opaque cursor', nullable: true, type: 'string' }))
    .toEqual({ description: 'opaque cursor', type: ['string', 'null'] })
})

test('denullify extends enum with null alongside the widened type', () => {
  expect(denullify({ nullable: true, type: 'string', enum: ['overlap', 'late'] }))
    .toEqual({ type: ['string', 'null'], enum: ['overlap', 'late', null] })
})

test('denullify widens array types and keeps items untouched', () => {
  expect(denullify({ nullable: true, type: 'array', items: { type: 'string' } }))
    .toEqual({ type: ['array', 'null'], items: { type: 'string' } })
})

test('denullify wraps allOf/composition nodes in an anyOf null union instead of a type array', () => {
  const input = { allOf: [{ $ref: '#/components/schemas/ServiceBuild' }], nullable: true, description: 'the newest build' }
  expect(denullify(input)).toEqual({
    anyOf: [{ allOf: [{ $ref: '#/components/schemas/ServiceBuild' }] }, { type: 'null' }],
    description: 'the newest build',
  })
})

test('denullify recurses through nested objects and arrays, e.g. a full schema document', () => {
  const doc = {
    paths: {
      '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string', nullable: true } } } } } } } } },
    },
    components: { schemas: { Foo: { type: 'string', nullable: true } } },
  }
  const out = denullify(doc)
  expect(out.paths['/x'].get.responses[200].content['application/json'].schema.properties.a).toEqual({ type: ['string', 'null'] })
  expect(out.components.schemas.Foo).toEqual({ type: ['string', 'null'] })
})

test('denullify recurses into array-valued keywords such as oneOf and items', () => {
  const input = { oneOf: [{ type: 'string', nullable: true }, { type: 'object', properties: { list: { type: 'array', items: { type: 'integer', nullable: true } } } }] }
  expect(denullify(input)).toEqual({
    oneOf: [{ type: ['string', 'null'] }, { type: 'object', properties: { list: { type: 'array', items: { type: ['integer', 'null'] } } } }],
  })
})

test('denullify leaves non-nullable schemas untouched', () => {
  const schema = { type: 'string', format: 'date-time' }
  expect(denullify(schema)).toEqual(schema)
})

test('denullify is idempotent: re-running it on already-normalized output is a no-op', () => {
  const once = denullify({ type: 'string', nullable: true, enum: ['a', 'b'] })
  expect(denullify(once)).toEqual(once)
})

test('applyRequiredHeaderFixups marks the documented-mandatory cron headers as required', () => {
  const updateCronJob = { parameters: [{ in: 'header', name: 'if-match', required: false }] }
  applyRequiredHeaderFixups('PATCH', '/projects/{projectId}/cron-jobs/{id}', updateCronJob)
  expect(updateCronJob.parameters[0].required).toBe(true)

  const triggerCronJob = { parameters: [{ in: 'header', name: 'idempotency-key', required: false }] }
  applyRequiredHeaderFixups('POST', '/projects/{projectId}/cron-jobs/{id}/runs', triggerCronJob)
  expect(triggerCronJob.parameters[0].required).toBe(true)
})

test('applyRequiredHeaderFixups does not touch unrelated operations or parameters', () => {
  const op = { parameters: [{ in: 'header', name: 'if-match', required: false }] }
  applyRequiredHeaderFixups('GET', '/projects/{projectId}/cron-jobs/{id}', op)
  expect(op.parameters[0].required).toBe(false)

  const noParams = {}
  expect(() => applyRequiredHeaderFixups('PATCH', '/projects/{projectId}/cron-jobs/{id}', noParams)).not.toThrow()
})

test('the fixup list only names header parameters', () => {
  for (const fixup of REQUIRED_HEADER_FIXUPS) expect(fixup.name).toMatch(/^[a-z-]+$/)
})
