# Changelog

## [1.0.0](https://github.com/mimsy/volute/compare/v0.4.0...v1.0.0) (2026-02-12)


### ⚠ BREAKING CHANGES

* reorganize CLI to noun-verb command structure ([#7](https://github.com/mimsy/volute/issues/7))

### Features

* accept message from stdin in send commands ([#18](https://github.com/mimsy/volute/issues/18)) ([2662d22](https://github.com/mimsy/volute/commit/2662d2263cdb4d611afc24da33ac2aa486566c74))
* add group conversations and channel gating ([#13](https://github.com/mimsy/volute/issues/13)) ([f327f3b](https://github.com/mimsy/volute/commit/f327f3b3771d9d2b87ffa6db191471f3f151d065))
* auto-update with daemon restart and web UI ([#10](https://github.com/mimsy/volute/issues/10)) ([b88238a](https://github.com/mimsy/volute/commit/b88238a2600eb2c264d42fc7443a25be4eab165b))
* improve agent routing, batching, and UI polish ([#16](https://github.com/mimsy/volute/issues/16)) ([8d9deb8](https://github.com/mimsy/volute/commit/8d9deb8a58b5e2d300edbf024c46149ac6e86bea))
* make agent name optional in volute agent commands ([#17](https://github.com/mimsy/volute/issues/17)) ([8bc0571](https://github.com/mimsy/volute/commit/8bc05713e49119765ebeb38ecff5e2c4e6c4a497))
* reorganize CLI to noun-verb command structure ([#7](https://github.com/mimsy/volute/issues/7)) ([f96c95f](https://github.com/mimsy/volute/commit/f96c95f78f513b135b29c0f1c8468910d0dda2b0))
* unify web chat and conversations ([#15](https://github.com/mimsy/volute/issues/15)) ([6661458](https://github.com/mimsy/volute/commit/6661458a520fc3ddfbbe90fc13ac511a3d8e88de))


### Bug Fixes

* create template branch during agent creation for clean upgrades ([#12](https://github.com/mimsy/volute/issues/12)) ([78fef97](https://github.com/mimsy/volute/commit/78fef976989827d17404d22105bbd99bed43e359))
* prevent tests from touching real ~/.volute directory ([#14](https://github.com/mimsy/volute/issues/14)) ([fffcbe1](https://github.com/mimsy/volute/commit/fffcbe11989e9df877e7bd2d1ba780477cf713ad))
* rotate log files by size to prevent unbounded growth ([#11](https://github.com/mimsy/volute/issues/11)) ([fdf708d](https://github.com/mimsy/volute/commit/fdf708dc9159ca2f8dc5a2f43fc3e9d3f9470578))
* scheduler consumes full stream, identity reload signals daemon ([#9](https://github.com/mimsy/volute/issues/9)) ([17f4979](https://github.com/mimsy/volute/commit/17f4979a59f112f0bac537da0e2a86bd50e06c39))

## [0.4.0](https://github.com/mimsy/volute/compare/v0.3.0...v0.4.0) (2026-02-10)


### Features

* add --version/-v and --help/-h flags to CLI ([64343dd](https://github.com/mimsy/volute/commit/64343dd849b5f19e7df9844f26fe62d290585489))
* add message routing, file destinations, and generalized connectors ([#4](https://github.com/mimsy/volute/issues/4)) ([aa18677](https://github.com/mimsy/volute/commit/aa18677673f68c4cb1de960d6e8c2569ed42df6b))
* add Slack and Telegram connectors with env var prompting ([#5](https://github.com/mimsy/volute/issues/5)) ([1e08a9e](https://github.com/mimsy/volute/commit/1e08a9e160866c6b037b20faca34989db0d4bc20))


### Bug Fixes

* scheduler leaks connections from unconsumed streaming responses ([#6](https://github.com/mimsy/volute/issues/6)) ([e7048a2](https://github.com/mimsy/volute/commit/e7048a29553a004217263ce4daed028abe754756))
