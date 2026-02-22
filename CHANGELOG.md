# Changelog

## [0.18.0](https://github.com/mimsy/volute/compare/volute-v0.17.0...volute-v0.18.0) (2026-02-22)


### Features

* add shared skills system ([#103](https://github.com/mimsy/volute/issues/103)) ([57ce779](https://github.com/mimsy/volute/commit/57ce7796c70d08cddaa9646dda7dc3f8878874dd))
* add volute channels ([#100](https://github.com/mimsy/volute/issues/100)) ([f3e308f](https://github.com/mimsy/volute/commit/f3e308f9b29669af68c238e058862942b5afb601))
* prompt management with admin settings and per-mind customization ([#98](https://github.com/mimsy/volute/issues/98)) ([fd88a97](https://github.com/mimsy/volute/commit/fd88a973adc1ffeb95f88d465413a0e5ea011539))
* unified IDE-like layout with sidebar, main frame, and status bar ([#102](https://github.com/mimsy/volute/issues/102)) ([1cbd3f7](https://github.com/mimsy/volute/commit/1cbd3f738409a1ed3a028ac56173fe3740832543))


### Bug Fixes

* normalize UTC timestamps for correct local time display ([#101](https://github.com/mimsy/volute/issues/101)) ([08ba0f1](https://github.com/mimsy/volute/commit/08ba0f1998770fbbbf73437ceaeb899cc6282785))

## [0.17.0](https://github.com/mimsy/volute/compare/volute-v0.16.0...volute-v0.17.0) (2026-02-21)


### Features

* add --image flag to volute send ([#97](https://github.com/mimsy/volute/issues/97)) ([d5f02e9](https://github.com/mimsy/volute/commit/d5f02e9b47bb846e4f97a2396af811ec95722fef))
* event-push architecture with transparency presets ([#91](https://github.com/mimsy/volute/issues/91)) ([229807c](https://github.com/mimsy/volute/commit/229807cdd58cc578cb08183e8cfcab59d88eebbd))
* migrate web frontend from React to Svelte 5 ([#93](https://github.com/mimsy/volute/issues/93))2 ([d3e2157](https://github.com/mimsy/volute/commit/d3e215727653dc3fe37e113ee31a07701776131a))
* redesign History tab with full activity timeline ([#96](https://github.com/mimsy/volute/issues/96)) ([d8b3d43](https://github.com/mimsy/volute/commit/d8b3d439ad96a3774556ff63c40f06b6d52791ec))
* replace mail polling with WebSocket notifications ([#94](https://github.com/mimsy/volute/issues/94)) ([b8e5f6c](https://github.com/mimsy/volute/commit/b8e5f6cb9c977cba9820e415a443b725e185d3a2))
* structured daemon logging with categories, levels, and filtered UI ([#95](https://github.com/mimsy/volute/issues/95)) ([9f79c04](https://github.com/mimsy/volute/commit/9f79c04001b67ea10d43b7ad7d62dc34067fe451))

## [0.16.0](https://github.com/mimsy/volute/compare/volute-v0.15.0...volute-v0.16.0) (2026-02-20)


### Features

* add volute pages CLI for publishing to volute.systems ([#88](https://github.com/mimsy/volute/issues/88)) ([3e4fef6](https://github.com/mimsy/volute/commit/3e4fef66653bb47101f1c1c9ddf54ef127d17ef4))
* generalize systems account + add mail integration ([#90](https://github.com/mimsy/volute/issues/90)) ([3167aed](https://github.com/mimsy/volute/commit/3167aed649bcf11357f3499da98d37985d9641da))

## [0.15.0](https://github.com/mimsy/volute/compare/volute-v0.14.1...volute-v0.15.0) (2026-02-19)


### Features

* inject reply instructions on first message of each session ([#86](https://github.com/mimsy/volute/issues/86)) ([3bbbffb](https://github.com/mimsy/volute/commit/3bbbffb3ab8ee362d9fbbad456ce90d72d2b4752))

## [0.14.1](https://github.com/mimsy/volute/compare/volute-v0.14.0...volute-v0.14.1) (2026-02-19)


### Bug Fixes

* system install permission fixes for upgrade, npm install, and sprout ([#84](https://github.com/mimsy/volute/issues/84)) ([d275f37](https://github.com/mimsy/volute/commit/d275f37a582ffc68216a3c601aea233f30452166))

## [0.14.0](https://github.com/mimsy/volute/compare/volute-v0.13.2...volute-v0.14.0) (2026-02-18)


### ⚠ BREAKING CHANGES

* rename agents to minds ([#83](https://github.com/mimsy/volute/issues/83))

### Features

* redesign web dashboard with activity tracking and nav improvements ([#81](https://github.com/mimsy/volute/issues/81)) ([9c44b5f](https://github.com/mimsy/volute/commit/9c44b5f696970d85752c9fa4e081f3fe3c9e4a38))
* rename agents to minds ([#83](https://github.com/mimsy/volute/issues/83)) ([468042f](https://github.com/mimsy/volute/commit/468042fb8c84ef12515611148170ef99981feaf5))
* serve static pages from agent home/pages/ directory ([#82](https://github.com/mimsy/volute/issues/82)) ([ffd5d71](https://github.com/mimsy/volute/commit/ffd5d71562fab977893d57e506d4ab6ec1fedd29))


### Bug Fixes

* pi template fixes and routing improvements ([#79](https://github.com/mimsy/volute/issues/79)) ([2ff3f2c](https://github.com/mimsy/volute/commit/2ff3f2cf06907c88541edc103483de045f83842e))

## [0.13.2](https://github.com/mimsy/volute/compare/volute-v0.13.1...volute-v0.13.2) (2026-02-17)


### Bug Fixes

* remove shared CLAUDE_CONFIG_DIR, use default $HOME/.claude per agent ([#77](https://github.com/mimsy/volute/issues/77)) ([d4e5600](https://github.com/mimsy/volute/commit/d4e56003e5395f7a3a0d83bc057143abc112188f))

## [0.13.1](https://github.com/mimsy/volute/compare/volute-v0.13.0...volute-v0.13.1) (2026-02-17)


### Bug Fixes

* remove RestrictSUIDSGID from systemd unit, fix daemon-e2e port collision ([#75](https://github.com/mimsy/volute/issues/75)) ([714cb31](https://github.com/mimsy/volute/commit/714cb31d4d9a69e0bb3eea4bde7bed0a87325f2b))

## [0.13.0](https://github.com/mimsy/volute/compare/volute-v0.12.0...volute-v0.13.0) (2026-02-17)


### Features

* orientation mode (seed/sprout lifecycle) ([#74](https://github.com/mimsy/volute/issues/74)) ([fa01956](https://github.com/mimsy/volute/commit/fa01956997ed603a3a09d3c12f3aeb177053ccef))
* share host .claude credentials with Docker agents via runuser isolation ([#72](https://github.com/mimsy/volute/issues/72)) ([290848a](https://github.com/mimsy/volute/commit/290848a7d1b847c5517d5cd78f82c557dd040938))

## [0.12.0](https://github.com/mimsy/volute/compare/volute-v0.11.4...volute-v0.12.0) (2026-02-17)


### Features

* use [@username](https://github.com/username) DM slugs for volute conversations ([#69](https://github.com/mimsy/volute/issues/69)) ([44b9d4d](https://github.com/mimsy/volute/commit/44b9d4ddd29e76191a91649e81af8e17599896dc))


### Bug Fixes

* use agent home/ dir for HOME and CLAUDE_CONFIG_DIR in isolation ([#70](https://github.com/mimsy/volute/issues/70)) ([f759882](https://github.com/mimsy/volute/commit/f7598822386dbdc34ffa7a1f0798f4ebd553684c))

## [0.11.4](https://github.com/mimsy/volute/compare/volute-v0.11.3...volute-v0.11.4) (2026-02-16)


### Bug Fixes

* bypass update check cache in volute update ([#66](https://github.com/mimsy/volute/issues/66)) ([8d59212](https://github.com/mimsy/volute/commit/8d592125ec0498139d271ba16280132e2abfb953))
* update check cache bypass and isolation chown fixes ([#68](https://github.com/mimsy/volute/issues/68)) ([cdb0ec6](https://github.com/mimsy/volute/commit/cdb0ec63cd2fe285b3d2ea1a9cacd9575c9231e0))

## [0.11.3](https://github.com/mimsy/volute/compare/volute-v0.11.2...volute-v0.11.3) (2026-02-16)


### Bug Fixes

* use writeFileSync for credential copy and add missing chownAgentDir ([#64](https://github.com/mimsy/volute/issues/64)) ([793100e](https://github.com/mimsy/volute/commit/793100eaf26ebe6ba991087a0856bea17583ba16))

## [0.11.2](https://github.com/mimsy/volute/compare/volute-v0.11.1...volute-v0.11.2) (2026-02-16)


### Bug Fixes

* fix git ownership and credential access for isolated agents ([#62](https://github.com/mimsy/volute/issues/62)) ([312df0f](https://github.com/mimsy/volute/commit/312df0f1d6ef8aaa5404ae47c95086325148a84b))

## [0.11.1](https://github.com/mimsy/volute/compare/volute-v0.11.0...volute-v0.11.1) (2026-02-16)


### Bug Fixes

* per-agent CLAUDE_CONFIG_DIR for isolated agent processes ([#60](https://github.com/mimsy/volute/issues/60)) ([1512981](https://github.com/mimsy/volute/commit/1512981036252687ba1e6130f3f58b1bb8dfe67c))

## [0.11.0](https://github.com/mimsy/volute/compare/volute-v0.10.2...volute-v0.11.0) (2026-02-16)


### Features

* add CLAUDE_CONFIG_DIR to system setup for shared agent credentials ([#56](https://github.com/mimsy/volute/issues/56)) ([b824aae](https://github.com/mimsy/volute/commit/b824aaea5b5399752554d26074cf94b54825fd64))
* unified service mode detection for daemon lifecycle commands ([#59](https://github.com/mimsy/volute/issues/59)) ([66862e5](https://github.com/mimsy/volute/commit/66862e574311d7bbd8881070c94b5286324dd5f1))


### Bug Fixes

* fix daemon message proxy handling and agent server robustness ([#58](https://github.com/mimsy/volute/issues/58)) ([c6a533f](https://github.com/mimsy/volute/commit/c6a533f0c6413a654a822c368736d3786edc9951))

## [0.10.2](https://github.com/mimsy/volute/compare/volute-v0.10.1...volute-v0.10.2) (2026-02-16)


### Bug Fixes

* use ProtectSystem=true to fix useradd locking ([#54](https://github.com/mimsy/volute/issues/54)) ([91004e5](https://github.com/mimsy/volute/commit/91004e56a4f2a0559b921de0b99e4f2d6ab673af))

## [0.10.1](https://github.com/mimsy/volute/compare/volute-v0.10.0...volute-v0.10.1) (2026-02-16)


### Bug Fixes

* fix useradd under systemd sandboxing and surface isolation errors ([#52](https://github.com/mimsy/volute/issues/52)) ([90e8f62](https://github.com/mimsy/volute/commit/90e8f621dbc7904e54b6907945a3d3518ccdf2bd))

## [0.10.0](https://github.com/mimsy/volute/compare/volute-v0.9.0...volute-v0.10.0) (2026-02-16)


### Features

* route remaining CLI commands through daemon API ([#50](https://github.com/mimsy/volute/issues/50)) ([41959ff](https://github.com/mimsy/volute/commit/41959ff1219a90b0f98cca52985d63c267ce37a6))

## [0.9.0](https://github.com/mimsy/volute/compare/volute-v0.8.3...volute-v0.9.0) (2026-02-15)


### Features

* route CLI commands through daemon API ([#48](https://github.com/mimsy/volute/issues/48)) ([7d68d0a](https://github.com/mimsy/volute/commit/7d68d0aee010c8b4b057f4d8548af430dda50da0))

## [0.8.3](https://github.com/mimsy/volute/compare/volute-v0.8.2...volute-v0.8.3) (2026-02-15)


### Bug Fixes

* systemd service detection and wrapper PATH fix ([#46](https://github.com/mimsy/volute/issues/46)) ([ca1e07f](https://github.com/mimsy/volute/commit/ca1e07f213b65d4aee344272885f5cb68406a654))

## [0.8.2](https://github.com/mimsy/volute/compare/volute-v0.8.1...volute-v0.8.2) (2026-02-15)


### Bug Fixes

* setup writes profile.d and wrapper for CLI access ([#44](https://github.com/mimsy/volute/issues/44)) ([5d4f1ff](https://github.com/mimsy/volute/commit/5d4f1ff3ee3c152575806c0278037e8127874fc0))

## [0.8.1](https://github.com/mimsy/volute/compare/volute-v0.8.0...volute-v0.8.1) (2026-02-15)


### Bug Fixes

* linux deployment issues with nvm and systemd ([#42](https://github.com/mimsy/volute/issues/42)) ([2b9e4fd](https://github.com/mimsy/volute/commit/2b9e4fd7d7dc109b4db8abdb6bc6d1474b3a2982))

## [0.8.0](https://github.com/mimsy/volute/compare/volute-v0.7.0...volute-v0.8.0) (2026-02-15)


### ⚠ BREAKING CHANGES

* linux deployment hardening and agent experience improvements ([#40](https://github.com/mimsy/volute/issues/40))
* separate system state from agent directories ([#39](https://github.com/mimsy/volute/issues/39))
* agent processing architecture overhaul ([#38](https://github.com/mimsy/volute/issues/38))
* replace NDJSON streaming with JSON request-response and unified send ([#37](https://github.com/mimsy/volute/issues/37))

### Features

* agent processing architecture overhaul ([#38](https://github.com/mimsy/volute/issues/38)) ([a235a1e](https://github.com/mimsy/volute/commit/a235a1e6175c702722b79bf130fb6ae46c9afed8))
* auto-chunk long messages in channel drivers ([#35](https://github.com/mimsy/volute/issues/35)) ([c941959](https://github.com/mimsy/volute/commit/c94195982f25e7d106e448302869e1ae0cecb26e))
* linux deployment hardening and agent experience improvements ([#40](https://github.com/mimsy/volute/issues/40)) ([5233321](https://github.com/mimsy/volute/commit/5233321490b1371832eefced95e13b4656eb8f93))
* replace NDJSON streaming with JSON request-response and unified send ([#37](https://github.com/mimsy/volute/issues/37)) ([e046df7](https://github.com/mimsy/volute/commit/e046df78fa655e3f263a84a949c53c01df8e4666))
* separate system state from agent directories ([#39](https://github.com/mimsy/volute/issues/39)) ([4372a84](https://github.com/mimsy/volute/commit/4372a8444d6c5ae0cd76fbbff12ed779d69fcbfd))

## [0.7.0](https://github.com/mimsy/volute/compare/volute-v0.6.0...volute-v0.7.0) (2026-02-13)


### Features

* improve web dashboard navigation and chat UX ([#34](https://github.com/mimsy/volute/issues/34)) ([ae9494e](https://github.com/mimsy/volute/commit/ae9494e06dd576f5c64e050a9b393a9ca4ffa1df))
* persist agent running state across daemon restarts ([#32](https://github.com/mimsy/volute/issues/32)) ([0a63a6a](https://github.com/mimsy/volute/commit/0a63a6ab9c5b3bb3512397ad9a9d4a4ba7abb9b7))


### Bug Fixes

* clear typing indicator when Discord message arrives ([#33](https://github.com/mimsy/volute/issues/33)) ([71506d7](https://github.com/mimsy/volute/commit/71506d74def79c9cafe2e1780ebaf3e4c0969e0b))
* resolve package.json for flat dist layout in update check ([#29](https://github.com/mimsy/volute/issues/29)) ([cdacc99](https://github.com/mimsy/volute/commit/cdacc99861f79ef307db5d6a1a469ab30669256e))
* volute chat generates human-readable channel slugs ([#30](https://github.com/mimsy/volute/issues/30)) ([906e2e3](https://github.com/mimsy/volute/commit/906e2e3095c7418886c787a164acd16809d44dfd))

## [0.6.0](https://github.com/mimsy/volute/compare/volute-v0.5.0...volute-v0.6.0) (2026-02-13)


### Features

* add agent restart command ([#26](https://github.com/mimsy/volute/issues/26)) ([f1d6a0f](https://github.com/mimsy/volute/commit/f1d6a0f27ccd66471fbb90e8fc041230f46e6a49))
* add cross-session awareness (short-term memory) ([#27](https://github.com/mimsy/volute/issues/27)) ([8798e68](https://github.com/mimsy/volute/commit/8798e68400d92f30c8f8c8a5567d293aeb2f9271))
* human-readable channel slugs ([#28](https://github.com/mimsy/volute/issues/28)) ([01ea512](https://github.com/mimsy/volute/commit/01ea5120b1251b41dde4085ead574bae12703cc5))
* per-agent token budgeting ([#25](https://github.com/mimsy/volute/issues/25)) ([9452314](https://github.com/mimsy/volute/commit/9452314b3f7799abc54e6099a852b5c0a7d24e82))
* typing indicators ([#24](https://github.com/mimsy/volute/issues/24)) ([809c895](https://github.com/mimsy/volute/commit/809c895aa1a99f6175f5cd85135258cbfa77a8d7))
* unified channel interface with message history persistence ([#23](https://github.com/mimsy/volute/issues/23)) ([21c2d9f](https://github.com/mimsy/volute/commit/21c2d9f51313c277ae2cc3d805b69478e9df40e6))


### Bug Fixes

* use daemon bind hostname for internal loopback connections ([#21](https://github.com/mimsy/volute/issues/21)) ([0ebd9df](https://github.com/mimsy/volute/commit/0ebd9df0bd82c427fd794c10046b95fc625b78b5))

## [0.5.0](https://github.com/mimsy/volute/compare/volute-v0.4.0...volute-v0.5.0) (2026-02-12)


### ⚠ BREAKING CHANGES

* reorganize CLI to noun-verb command structure ([#7](https://github.com/mimsy/volute/issues/7))

### Features

* accept message from stdin in send commands ([#18](https://github.com/mimsy/volute/issues/18)) ([2662d22](https://github.com/mimsy/volute/commit/2662d2263cdb4d611afc24da33ac2aa486566c74))
* add --version/-v and --help/-h flags to CLI ([64343dd](https://github.com/mimsy/volute/commit/64343dd849b5f19e7df9844f26fe62d290585489))
* add group conversations and channel gating ([#13](https://github.com/mimsy/volute/issues/13)) ([f327f3b](https://github.com/mimsy/volute/commit/f327f3b3771d9d2b87ffa6db191471f3f151d065))
* add message routing, file destinations, and generalized connectors ([#4](https://github.com/mimsy/volute/issues/4)) ([aa18677](https://github.com/mimsy/volute/commit/aa18677673f68c4cb1de960d6e8c2569ed42df6b))
* add Slack and Telegram connectors with env var prompting ([#5](https://github.com/mimsy/volute/issues/5)) ([1e08a9e](https://github.com/mimsy/volute/commit/1e08a9e160866c6b037b20faca34989db0d4bc20))
* auto-update with daemon restart and web UI ([#10](https://github.com/mimsy/volute/issues/10)) ([b88238a](https://github.com/mimsy/volute/commit/b88238a2600eb2c264d42fc7443a25be4eab165b))
* improve agent routing, batching, and UI polish ([#16](https://github.com/mimsy/volute/issues/16)) ([8d9deb8](https://github.com/mimsy/volute/commit/8d9deb8a58b5e2d300edbf024c46149ac6e86bea))
* make agent name optional in volute agent commands ([#17](https://github.com/mimsy/volute/issues/17)) ([8bc0571](https://github.com/mimsy/volute/commit/8bc05713e49119765ebeb38ecff5e2c4e6c4a497))
* reorganize CLI to noun-verb command structure ([#7](https://github.com/mimsy/volute/issues/7)) ([f96c95f](https://github.com/mimsy/volute/commit/f96c95f78f513b135b29c0f1c8468910d0dda2b0))
* unify web chat and conversations ([#15](https://github.com/mimsy/volute/issues/15)) ([6661458](https://github.com/mimsy/volute/commit/6661458a520fc3ddfbbe90fc13ac511a3d8e88de))


### Bug Fixes

* configure release-please for pre-v1 semver ([#19](https://github.com/mimsy/volute/issues/19)) ([cac1492](https://github.com/mimsy/volute/commit/cac1492c67b63ad30b7204d3aa009c35941ee505))
* create template branch during agent creation for clean upgrades ([#12](https://github.com/mimsy/volute/issues/12)) ([78fef97](https://github.com/mimsy/volute/commit/78fef976989827d17404d22105bbd99bed43e359))
* prevent tests from touching real ~/.volute directory ([#14](https://github.com/mimsy/volute/issues/14)) ([fffcbe1](https://github.com/mimsy/volute/commit/fffcbe11989e9df877e7bd2d1ba780477cf713ad))
* rotate log files by size to prevent unbounded growth ([#11](https://github.com/mimsy/volute/issues/11)) ([fdf708d](https://github.com/mimsy/volute/commit/fdf708dc9159ca2f8dc5a2f43fc3e9d3f9470578))
* scheduler consumes full stream, identity reload signals daemon ([#9](https://github.com/mimsy/volute/issues/9)) ([17f4979](https://github.com/mimsy/volute/commit/17f4979a59f112f0bac537da0e2a86bd50e06c39))
* scheduler leaks connections from unconsumed streaming responses ([#6](https://github.com/mimsy/volute/issues/6)) ([e7048a2](https://github.com/mimsy/volute/commit/e7048a29553a004217263ce4daed028abe754756))

## [0.4.0](https://github.com/mimsy/volute/compare/v0.3.0...v0.4.0) (2026-02-10)


### Features

* add --version/-v and --help/-h flags to CLI ([64343dd](https://github.com/mimsy/volute/commit/64343dd849b5f19e7df9844f26fe62d290585489))
* add message routing, file destinations, and generalized connectors ([#4](https://github.com/mimsy/volute/issues/4)) ([aa18677](https://github.com/mimsy/volute/commit/aa18677673f68c4cb1de960d6e8c2569ed42df6b))
* add Slack and Telegram connectors with env var prompting ([#5](https://github.com/mimsy/volute/issues/5)) ([1e08a9e](https://github.com/mimsy/volute/commit/1e08a9e160866c6b037b20faca34989db0d4bc20))


### Bug Fixes

* scheduler leaks connections from unconsumed streaming responses ([#6](https://github.com/mimsy/volute/issues/6)) ([e7048a2](https://github.com/mimsy/volute/commit/e7048a29553a004217263ce4daed028abe754756))
