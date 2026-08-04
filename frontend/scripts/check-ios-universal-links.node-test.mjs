import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectIosUniversalLinks, loadIosUniversalLinkSources } from './check-ios-universal-links.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sources = () => loadIosUniversalLinkSources(root)
const messages = (candidate) => inspectIosUniversalLinks(candidate).join('\n')

test('accepts the iOS Universal Links source contract', () => {
  assert.deepEqual(inspectIosUniversalLinks(sources()), [])
})

test('rejects entitlement, association, hosting, and policy drift', () => {
  const cases = [
    [(candidate) => { candidate.project = candidate.project.replace('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;', 'CODE_SIGN_ENTITLEMENTS = App/Other.entitlements;') }, /Debug and Release/],
    [(candidate) => { candidate.entitlements = candidate.entitlements.replace('applinks:dupert.vercel.app', 'applinks:evil.example') }, /associated domains/],
    [(candidate) => { candidate.association = candidate.association.replace('UK537LHYVG.io.github.tyhuang9.dupert', 'OTHER.io.github.tyhuang9.dupert') }, /appID/],
    [(candidate) => { candidate.association = candidate.association.replace('"apps": []', '"apps": ["legacy"]') }, /legacy apps/],
    [(candidate) => { candidate.association = candidate.association.replace('"applinks": {', '"other": {},\n  "applinks": {') }, /only applinks/],
    [(candidate) => { candidate.association = candidate.association.replace('/reset-password', '/anything') }, /routes/],
    [(candidate) => { candidate.vercel = candidate.vercel.replace('application/json', 'text/html') }, /headers are invalid or conflicting/],
    [(candidate) => { candidate.vercel = candidate.vercel.replace('"headers": [\n        {', '"headers": [\n        {\n          "key": "Content-Type",\n          "value": "text/html"\n        },\n        {') }, /headers are invalid or conflicting/],
    [(candidate) => { candidate.policy = candidate.policy.replace('https://dupert.vercel.app', 'https://evil.example') }, /owned Universal Links host/],
  ]
  for (const [mutate, expected] of cases) {
    const candidate = sources()
    mutate(candidate)
    assert.match(messages(candidate), expected)
  }
})
