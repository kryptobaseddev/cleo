'use strict';
/**
 * Child-process probe for the native-vs-WASI parity test (T12382).
 *
 * Loads the napi-rs generated loader (packages/cant/napi/index.cjs) in a
 * FRESH process, so the backend choice is made from this process's
 * environment (`NAPI_RS_FORCE_WASI=error` forces the WebAssembly build), and
 * runs every exported parse/validate/extract function over the files named
 * in the JSON list at argv[2]. Prints one JSON object to stdout.
 *
 * A fresh process is required: Node caches `require()` results per process,
 * so an in-process test could silently reuse whichever backend loaded first.
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const binding = require(join(__dirname, '..', '..', 'napi', 'index.cjs'));
const files = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const results = {};
for (const file of files) {
  const content = readFileSync(file.absolute, 'utf8');
  results[file.relative] = {
    parseDocument: binding.cantParseDocument(content),
    validateDocument: binding.cantValidateDocument(content),
    extractAgentProfiles: binding.cantExtractAgentProfiles(content),
    parseMessage: binding.cantParse(content),
  };
}

const directives = ['done', 'claim', 'blocked', 'action', 'review', 'ack', 'info', 'unknown-verb'];

Promise.resolve(binding.cantExecutePipeline(process.argv[3] || '/nonexistent.cant', 'probe')).then(
  (pipeline) => {
    process.stdout.write(
      JSON.stringify({
        backend: binding.cantBackend(),
        buildInfo: binding.cantBuildInfo(),
        classify: directives.map((verb) => binding.cantClassifyDirective(verb)),
        results,
        pipeline,
      }),
    );
  },
);
