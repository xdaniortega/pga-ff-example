// Preloaded by `npm test` (--import): node's test runner sets FORCE_COLOR=1 in its children when run from a terminal, which would
// put ANSI codes into every spawned command's output the tests parse. Tests that need colour set FORCE_COLOR themselves.
delete process.env.FORCE_COLOR
delete process.env.NO_COLOR
