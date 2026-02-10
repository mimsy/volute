# Changelog

## [0.4.0](https://github.com/mimsy/volute/compare/v0.3.0...v0.4.0) (2026-02-10)


### Features

* add --version/-v and --help/-h flags to CLI ([64343dd](https://github.com/mimsy/volute/commit/64343dd849b5f19e7df9844f26fe62d290585489))
* add message routing, file destinations, and generalized connectors ([#4](https://github.com/mimsy/volute/issues/4)) ([aa18677](https://github.com/mimsy/volute/commit/aa18677673f68c4cb1de960d6e8c2569ed42df6b))
* add Slack and Telegram connectors with env var prompting ([#5](https://github.com/mimsy/volute/issues/5)) ([1e08a9e](https://github.com/mimsy/volute/commit/1e08a9e160866c6b037b20faca34989db0d4bc20))


### Bug Fixes

* scheduler leaks connections from unconsumed streaming responses ([#6](https://github.com/mimsy/volute/issues/6)) ([e7048a2](https://github.com/mimsy/volute/commit/e7048a29553a004217263ce4daed028abe754756))
