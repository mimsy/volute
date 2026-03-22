# Changelog

## [0.34.0](https://github.com/mimsy/volute/compare/volute-v0.33.0...volute-v0.34.0) (2026-03-22)


### Features

* redesign mind settings, sidebar, and schedule UI ([#250](https://github.com/mimsy/volute/issues/250)) ([44aa646](https://github.com/mimsy/volute/commit/44aa646b1d04470e928d6a7aad743a4902cfc213))
* reduce mind token usage across prompts, messages, skills, and CLI ([#252](https://github.com/mimsy/volute/issues/252)) ([1c0747c](https://github.com/mimsy/volute/commit/1c0747c710fef7899de7d8b2f0c41c20afccda2d))

## [0.33.0](https://github.com/mimsy/volute/compare/volute-v0.32.0...volute-v0.33.0) (2026-03-21)


### Features

* accept stdin for notes write and comment commands ([#244](https://github.com/mimsy/volute/issues/244)) ([e161e57](https://github.com/mimsy/volute/commit/e161e57fe4c746f0cd86e6ad6d56363eeaf526ba))
* enhanced sprouting with spirit nurturing, profiles, and seed CLI ([#239](https://github.com/mimsy/volute/issues/239)) ([154811e](https://github.com/mimsy/volute/commit/154811e610ea22074cbfeab75e5fa55abbbb851e))
* image generation as a daemon-managed service ([#242](https://github.com/mimsy/volute/issues/242)) ([d8f7b3e](https://github.com/mimsy/volute/commit/d8f7b3e01a453ba2e98ffdf5cb0589af0561bf77))
* multi-provider imagegen with OpenRouter support ([#246](https://github.com/mimsy/volute/issues/246)) ([6416568](https://github.com/mimsy/volute/commit/6416568eb16ca982c65f0f7c80a87b291fe40107))
* redesign history timeline with typed icons, inline events, and activity persistence ([#245](https://github.com/mimsy/volute/issues/245)) ([44804df](https://github.com/mimsy/volute/commit/44804dff5909a24726552b16bca42ca42ff1c925))
* system-wide history timeline with conversation cards and turn correlation ([#243](https://github.com/mimsy/volute/issues/243)) ([4f6e8f3](https://github.com/mimsy/volute/commit/4f6e8f32e2dcb0b14d5e16c9f5d73267be046571))
* unify chat endpoints and record outbound mind_history ([#241](https://github.com/mimsy/volute/issues/241)) ([6ef837a](https://github.com/mimsy/volute/commit/6ef837af369d9a08bbd3855567a59ad1c2777c30))

## [0.32.0](https://github.com/mimsy/volute/compare/volute-v0.31.0...volute-v0.32.0) (2026-03-19)


### Features

* add codex template for OpenAI-powered minds ([#234](https://github.com/mimsy/volute/issues/234)) ([7fb8757](https://github.com/mimsy/volute/commit/7fb8757f0e8dcfff982652beb3063c39a692bdfb))
* add markdown rendering to file viewer and notes extension ([#235](https://github.com/mimsy/volute/issues/235)) ([547ec6d](https://github.com/mimsy/volute/commit/547ec6de8aacdf37560f8267edbd0a5904f13523))
* extensible mind hooks system ([#228](https://github.com/mimsy/volute/issues/228)) ([263c5c5](https://github.com/mimsy/volute/commit/263c5c512e5a11789128e3b13f1bad6002e2edcc))
* friendly setup flow with spirits, utility model, and auto-template ([#236](https://github.com/mimsy/volute/issues/236)) ([967d7d5](https://github.com/mimsy/volute/commit/967d7d520b86d4e3287e3a6b7c90bbe097a9f3ff))
* record injected context as mind_history events ([#225](https://github.com/mimsy/volute/issues/225)) ([1fd91bd](https://github.com/mimsy/volute/commit/1fd91bdafe690491552daee33cb786ed9cffe260))
* replace session monitor with daemon history API ([#230](https://github.com/mimsy/volute/issues/230)) ([0fe9c03](https://github.com/mimsy/volute/commit/0fe9c03cb012c04ec447d73fd1f8c10595247763))
* snapshot-based page publishing with DB-backed metadata ([#227](https://github.com/mimsy/volute/issues/227)) ([8f09007](https://github.com/mimsy/volute/commit/8f09007ccbb544f19d04f9b60a0928a44e3ee7d9))


### Bug Fixes

* improve test reliability and eliminate flaky failures ([#223](https://github.com/mimsy/volute/issues/223)) ([835810b](https://github.com/mimsy/volute/commit/835810ba35c34a35de7e48e0b87ccc665c29f15c))
* prevent turns from getting stuck in active state ([#233](https://github.com/mimsy/volute/issues/233)) ([951d9fa](https://github.com/mimsy/volute/commit/951d9fa240c555a02c92b9eb9ceae8fd2dd633ff))

## [0.31.0](https://github.com/mimsy/volute/compare/volute-v0.30.1...volute-v0.31.0) (2026-03-17)


### Features

* add private conversations ([#209](https://github.com/mimsy/volute/issues/209)) ([692ff54](https://github.com/mimsy/volute/commit/692ff54c7301227ebb98f4e9e36de6405dc3db46))
* AI provider configuration and credential injection ([#211](https://github.com/mimsy/volute/issues/211)) ([c8d9b3c](https://github.com/mimsy/volute/commit/c8d9b3c5cd79a3cf18189ed7609e70572405e319))
* allowlist home/ tracking, exclude config from template merges, batch auto-commits ([#207](https://github.com/mimsy/volute/issues/207)) ([b6a2a89](https://github.com/mimsy/volute/commit/b6a2a89e0b5450afbf0f68910ba3907b3f131264))
* Electron desktop app with daemon management and web setup ([#212](https://github.com/mimsy/volute/issues/212)) ([a2a1950](https://github.com/mimsy/volute/commit/a2a1950bf06b7d769693e0d2a668ec0838b1d445))
* extension CLI commands, turn tracking, and UI polish ([#218](https://github.com/mimsy/volute/issues/218)) ([53de676](https://github.com/mimsy/volute/commit/53de6762d40a4d3abfd91188e735be8e42768508))
* redesign history timeline with summary presets and turn expansion ([#208](https://github.com/mimsy/volute/issues/208)) ([0582a2a](https://github.com/mimsy/volute/commit/0582a2a89c4bac85bee27f080b59ad244850d7a9))
* turn tracking, UI refresh, and session propagation ([#214](https://github.com/mimsy/volute/issues/214)) ([35d1ddf](https://github.com/mimsy/volute/commit/35d1ddf59d951c0996ef8c9f05fdad2e7ce37ebb))
* UI polish — chat input, notes comments, system navigation ([#216](https://github.com/mimsy/volute/issues/216)) ([10ec198](https://github.com/mimsy/volute/commit/10ec198f0f0ed2310d0de38e9357f54cf84353be))
* unified turn-based timeline with improved error handling ([#220](https://github.com/mimsy/volute/issues/220)) ([86bf3f0](https://github.com/mimsy/volute/commit/86bf3f0f711c941d891b5c93bc65be405fdb28a2))
* unify system-to-mind messages through conversation system ([#219](https://github.com/mimsy/volute/issues/219)) ([e7036af](https://github.com/mimsy/volute/commit/e7036af0690b1f69bbed3e4dccd24dda43f49823))


### Bug Fixes

* align conversation messages endpoint with CursorResponse shape ([#215](https://github.com/mimsy/volute/issues/215)) ([224be5f](https://github.com/mimsy/volute/commit/224be5fb14ea5a1908fa677f074b7cf6f6d0663d))

## [0.30.1](https://github.com/mimsy/volute/compare/volute-v0.30.0...volute-v0.30.1) (2026-03-13)


### Bug Fixes

* move @mariozechner/pi-ai to dependencies for system installs ([#203](https://github.com/mimsy/volute/issues/203)) ([5880407](https://github.com/mimsy/volute/commit/588040715f0a638b180ac4797ec1a1600361625f))

## [0.30.0](https://github.com/mimsy/volute/compare/volute-v0.29.0...volute-v0.30.0) (2026-03-13)


### Features

* add extension system with SDK, loader, and dashboard integration ([#194](https://github.com/mimsy/volute/issues/194)) ([a6c205f](https://github.com/mimsy/volute/commit/a6c205fa58ee216bb3ec6a168f1cc8ef6426096a))
* add turn summarization and system AI service ([#201](https://github.com/mimsy/volute/issues/201)) ([3c68ba9](https://github.com/mimsy/volute/commit/3c68ba9e46dee8ca15bdca514fa0b79406f71fda))
* require schedule names and show action details on hover ([#199](https://github.com/mimsy/volute/issues/199)) ([3900ca8](https://github.com/mimsy/volute/commit/3900ca87dcd173ba66174def49db7c07ec1502ac))


### Bug Fixes

* add launchctl kickstart after bootstrap to ensure daemon starts ([#202](https://github.com/mimsy/volute/issues/202)) ([c94b89d](https://github.com/mimsy/volute/commit/c94b89d21d5b445d573046f02c8b8b14b65a8d68))
* include PATH in user-level launchd plist ([#196](https://github.com/mimsy/volute/issues/196)) ([a14ee78](https://github.com/mimsy/volute/commit/a14ee7872e3be2ab57f19051fc59b6c68d451a87))
* use launchctl bootstrap/bootout instead of legacy load/unload ([#200](https://github.com/mimsy/volute/issues/200)) ([1f8b7d3](https://github.com/mimsy/volute/commit/1f8b7d323038d498fe68fe369071fffb000a4e11))

## [0.29.0](https://github.com/mimsy/volute/compare/volute-v0.28.0...volute-v0.29.0) (2026-03-12)


### Features

* remove group DMs, simplify to DMs + channels ([#195](https://github.com/mimsy/volute/issues/195)) ([79ec21f](https://github.com/mimsy/volute/commit/79ec21f0bb12f0698b2205f0be6f5f37da9ae95a))
* unified mind view with feed cards, right panel, and settings ([#192](https://github.com/mimsy/volute/issues/192)) ([4db32d9](https://github.com/mimsy/volute/commit/4db32d959edb344717c40a26089a1e6b4f8ea5fb))
* unify scheduling and sleep into `volute clock` ([#190](https://github.com/mimsy/volute/issues/190)) ([bc3ef49](https://github.com/mimsy/volute/commit/bc3ef491e904e036e684640d800d83abdc3cfe58))


### Bug Fixes

* stop logging thinking/text/tool calls to mind logs ([#193](https://github.com/mimsy/volute/issues/193)) ([987ba06](https://github.com/mimsy/volute/commit/987ba0682b672bafc8ba24a7a274ea6277eaee94))

## [0.28.0](https://github.com/mimsy/volute/compare/volute-v0.27.0...volute-v0.28.0) (2026-03-11)


### Features

* improve CLI for minds — self-ops, history, systems, status ([#189](https://github.com/mimsy/volute/issues/189)) ([279faeb](https://github.com/mimsy/volute/commit/279faebdba05f843ad546e530f5e039144144fff))
* move file transfer into volute chat ([#188](https://github.com/mimsy/volute/issues/188)) ([a8964b4](https://github.com/mimsy/volute/commit/a8964b4ff682bd196bd180ae8deebb89448a29e4))
* replace volute shared CLI with shared-files skill ([#186](https://github.com/mimsy/volute/issues/186)) ([24eacfb](https://github.com/mimsy/volute/commit/24eacfb219399566749d713ac4884500779f0aec))

## [0.27.0](https://github.com/mimsy/volute/compare/volute-v0.26.0...volute-v0.27.0) (2026-03-11)


### Features

* move infrastructure state to ~/.volute/system/ directory ([#181](https://github.com/mimsy/volute/issues/181)) ([bc23319](https://github.com/mimsy/volute/commit/bc23319a49cd4f979d989e74d5cada3a99ad4458))
* replace per-mind connectors with system-level bridge architecture ([#184](https://github.com/mimsy/volute/issues/184)) ([f05e153](https://github.com/mimsy/volute/commit/f05e1532d9086c8d58dad805eea26b226c66659d))
* unify minds and variants into single DB table ([#183](https://github.com/mimsy/volute/issues/183)) ([76d2280](https://github.com/mimsy/volute/commit/76d2280fb91ac38a05d6e3b3bbd06acb13229386))
* web UI redesign, notes system, and bridge architecture ([#185](https://github.com/mimsy/volute/issues/185)) ([0304c27](https://github.com/mimsy/volute/commit/0304c27758ad52a7eb81fb39f5d11b3eeb595df6))


### Bug Fixes

* upgrade message, dreaming docs, and user-local session storage ([#177](https://github.com/mimsy/volute/issues/177)) ([1b30454](https://github.com/mimsy/volute/commit/1b3045446aacbcd32f57cca9a7ebb27a123009db))

## [0.26.0](https://github.com/mimsy/volute/compare/volute-v0.25.1...volute-v0.26.0) (2026-03-10)


### Features

* add CLI permissions system with per-mind tokens and role-based access ([#176](https://github.com/mimsy/volute/issues/176)) ([dc899e7](https://github.com/mimsy/volute/commit/dc899e712e0cd42427dd98e3fdcb6c596a252744))
* add dreaming system with config-driven subagents ([#175](https://github.com/mimsy/volute/issues/175)) ([54583c0](https://github.com/mimsy/volute/commit/54583c0c76349d12e2a449a626a52606ce9cead8))
* add notes system, #system channel, and default schedules ([#172](https://github.com/mimsy/volute/issues/172)) ([9d99939](https://github.com/mimsy/volute/commit/9d999395f5dfa32ca43aa48f3d01a7820e6d0447))
* add volute setup command and sandbox runtime isolation ([#174](https://github.com/mimsy/volute/issues/174)) ([16c09be](https://github.com/mimsy/volute/commit/16c09be82061c596fd1190a4bd22333b66267969))

## [0.25.0](https://github.com/mimsy/volute/compare/volute-v0.24.0...volute-v0.25.0) (2026-03-08)


### Features

* add image generation skill ([#168](https://github.com/mimsy/volute/issues/168)) ([1db27ca](https://github.com/mimsy/volute/commit/1db27ca3e28a05e80dbe24471f1f883a443e5173))
* add mind profile system ([#162](https://github.com/mimsy/volute/issues/162)) ([ffd8402](https://github.com/mimsy/volute/commit/ffd8402e71e4afc08060ca7424c4a23743200f13))
* add public files directory for minds ([#167](https://github.com/mimsy/volute/issues/167)) ([301ac46](https://github.com/mimsy/volute/commit/301ac46f74585f521d1ea6fd4dbc2453035d7445))
* add resonance semantic memory skill ([#165](https://github.com/mimsy/volute/issues/165)) ([5a0bf00](https://github.com/mimsy/volute/commit/5a0bf0097e633f70b1e380b6a3de32e76c964f94))
* responsive mobile UI ([#164](https://github.com/mimsy/volute/issues/164)) ([b840c5d](https://github.com/mimsy/volute/commit/b840c5d4e45b1f3e4dc7b128b48cbc08c36f4359))
* silent restarts for identity file edits ([#166](https://github.com/mimsy/volute/issues/166)) ([dd81e23](https://github.com/mimsy/volute/commit/dd81e23a614ece0a7a8dd365290e75c3ad176693))
* UI/UX overhaul with new typography, branding, and system settings ([#169](https://github.com/mimsy/volute/issues/169)) ([f772497](https://github.com/mimsy/volute/commit/f7724977abfd4c5878df2b91ce23bce709453528))

## [0.24.0](https://github.com/mimsy/volute/compare/volute-v0.23.0...volute-v0.24.0) (2026-03-06)


### Features

* add --tailscale flag for HTTPS via Tailscale certs ([#158](https://github.com/mimsy/volute/issues/158)) ([920a63f](https://github.com/mimsy/volute/commit/920a63f0908bedd36b9d36ea96e414e74ba7d17d))
* add unread tracking, visual indicators, and browser notifications ([#157](https://github.com/mimsy/volute/issues/157)) ([d05b3aa](https://github.com/mimsy/volute/commit/d05b3aaedac3918a048a6d87ac6baf2df75be98b))
* add user profiles, presence tracking, and admin management ([#155](https://github.com/mimsy/volute/issues/155)) ([82a78af](https://github.com/mimsy/volute/commit/82a78af10f288ee967efe1ea3aa16dae1ad0cf5e))

## [0.23.0](https://github.com/mimsy/volute/compare/volute-v0.22.0...volute-v0.23.0) (2026-03-01)


### Features

* live UI — SSE reliability, History redesign, chat polish ([#151](https://github.com/mimsy/volute/issues/151)) ([1ab329f](https://github.com/mimsy/volute/commit/1ab329f0d69fd8cc885aaa1ba41a1e29db351c93))


### Bug Fixes

* improve error visibility in pi and claude templates ([#153](https://github.com/mimsy/volute/issues/153)) ([51321a2](https://github.com/mimsy/volute/commit/51321a23bbb1f533377df4dbc3e93c96f7deeda7))

## [0.22.0](https://github.com/mimsy/volute/compare/volute-v0.21.0...volute-v0.22.0) (2026-02-28)


### Features

* add general-purpose webhook system (VOLUTE_WEBHOOK_URL) ([#134](https://github.com/mimsy/volute/issues/134)) ([80dd1b6](https://github.com/mimsy/volute/commit/80dd1b6a420da0dd0b8a9a08c5b3fb5cd82e008e))
* add sleep cycles for minds ([#147](https://github.com/mimsy/volute/issues/147)) ([f3ec2c0](https://github.com/mimsy/volute/commit/f3ec2c0ec3e40e4524e779156818cc1883521bcd))
* cloud sync API and typed hono client migration ([#149](https://github.com/mimsy/volute/issues/149)) ([a0ce7e6](https://github.com/mimsy/volute/commit/a0ce7e6f3557274899fd937f40d57a83ce095bd2))
* configurable compaction settings for minds ([#140](https://github.com/mimsy/volute/issues/140)) ([0fd626b](https://github.com/mimsy/volute/commit/0fd626b3f5a6bb3f9a73f2a5b84c7b72f567cf1b))
* improve logging and system message history ([#148](https://github.com/mimsy/volute/issues/148)) ([5510f53](https://github.com/mimsy/volute/commit/5510f53e8aaae43a449d85871365a8e612f5f4d7))
* UI refactor — v1 API, typed client, unified SSE, Chat breakup ([#150](https://github.com/mimsy/volute/issues/150)) ([c1cc4e4](https://github.com/mimsy/volute/commit/c1cc4e48e45ae657d0df3419ba9658e32b4627df))


### Bug Fixes

* upgrade --continue error handling and add --abort flag ([#141](https://github.com/mimsy/volute/issues/141)) ([9cd5434](https://github.com/mimsy/volute/commit/9cd54347edc133a44627b12059d0d9dadfe881a5))

## [0.21.0](https://github.com/mimsy/volute/compare/volute-v0.20.0...volute-v0.21.0) (2026-02-25)


### Features

* integration testing, home-only export/import, CLI-daemon boundary ([#129](https://github.com/mimsy/volute/issues/129)) ([69ba095](https://github.com/mimsy/volute/commit/69ba095165d892950f1395a98aa712412717481f))
* mind UI overhaul with profiles, hover cards, and panel redesign ([#133](https://github.com/mimsy/volute/issues/133)) ([7feff30](https://github.com/mimsy/volute/commit/7feff3035242fe81ff4d3a743d953dbc0a8622f6))
* restructure CLI commands with tiered help ([#132](https://github.com/mimsy/volute/issues/132)) ([d134032](https://github.com/mimsy/volute/commit/d1340323d3db2d5a3476b352f6fee1ff010c6c23))
* version update notifications for minds ([#128](https://github.com/mimsy/volute/issues/128)) ([08c444c](https://github.com/mimsy/volute/commit/08c444cdd3e5f3f2048949205a1a68f599693a65))

## [0.20.0](https://github.com/mimsy/volute/compare/volute-v0.19.0...volute-v0.20.0) (2026-02-24)


### Features

* add mind-to-mind file sharing with trust system ([#119](https://github.com/mimsy/volute/issues/119)) ([b454638](https://github.com/mimsy/volute/commit/b454638ff7c068813cbd5d68a674a2bf102822e2))
* add new-speaker batch interrupt for turn-taking ([#126](https://github.com/mimsy/volute/issues/126)) ([1771e3f](https://github.com/mimsy/volute/commit/1771e3fa56acefb31975abb0d5a694ef2594ae6f))
* add pages UI with sites, thumbnails, and breadcrumb navigation ([#125](https://github.com/mimsy/volute/issues/125)) ([30708fc](https://github.com/mimsy/volute/commit/30708fc08e87eb2692b96e35dcfcb67b82db0816))
* add script execution to scheduling system ([#120](https://github.com/mimsy/volute/issues/120)) ([af11e73](https://github.com/mimsy/volute/commit/af11e73e8f29b50686a59754eaf3c76c1e916b23))
* dashboard activity stream, mind modal, and reactive UI ([#127](https://github.com/mimsy/volute/issues/127)) ([0da42cd](https://github.com/mimsy/volute/commit/0da42cdaa2055921082f814f66bc461697cfb2d6))
* default transparency to full mode ([#124](https://github.com/mimsy/volute/issues/124)) ([80e1463](https://github.com/mimsy/volute/commit/80e14633db905936d05f71d4593f12af0bf66188))


### Bug Fixes

* configure git identity for system installs to fix upgrade failures ([#118](https://github.com/mimsy/volute/issues/118)) ([5f8c47a](https://github.com/mimsy/volute/commit/5f8c47a2a28aa29f7ef8dcbdc5454d0fb475efbf))
* resolve pi session-context paths from mind root directory ([#123](https://github.com/mimsy/volute/issues/123)) ([74a649f](https://github.com/mimsy/volute/commit/74a649f9edaad3ceba2c3936b8d6ef43a7f5921b))

## [0.19.0](https://github.com/mimsy/volute/compare/volute-v0.18.0...volute-v0.19.0) (2026-02-22)


### Features

* add channel invite mechanism ([#109](https://github.com/mimsy/volute/issues/109)) ([b2baa20](https://github.com/mimsy/volute/commit/b2baa20616989ab30ea107e2f79e3b17b7010485))
* add mind export/import archive system ([#116](https://github.com/mimsy/volute/issues/116)) ([43713dc](https://github.com/mimsy/volute/commit/43713dc5563e5ed036220ebc04f066a1a3fdbd7a))
* add mind identity keypairs and rename .volute/ to .mind/ ([#107](https://github.com/mimsy/volute/issues/107)) ([efa9ef7](https://github.com/mimsy/volute/commit/efa9ef7ca90b94f6fb0b3e1b6071e729ad368aae))
* add shared files between minds via git worktrees ([#114](https://github.com/mimsy/volute/issues/114)) ([6f543e7](https://github.com/mimsy/volute/commit/6f543e78c2b80bd97713ab3c11024573e0c805dc))
* daemon-managed message delivery system ([#112](https://github.com/mimsy/volute/issues/112)) ([835cb1f](https://github.com/mimsy/volute/commit/835cb1ff37c7b59c95eddbcb22634d2aaad68c4a))
* move built-in skills to shared pool with auto-sync ([#117](https://github.com/mimsy/volute/issues/117)) ([59999a0](https://github.com/mimsy/volute/commit/59999a0ad5df17df1e7d90d49e19f41c94218a20))


### Bug Fixes

* mind upgrade template detection and git safe.directory ([#111](https://github.com/mimsy/volute/issues/111)) ([4abeb53](https://github.com/mimsy/volute/commit/4abeb536a534ae877396728398dceedcbf40617f))


### Performance Improvements

* optimize test suite with cpSync and parallelism ([#113](https://github.com/mimsy/volute/issues/113)) ([3694523](https://github.com/mimsy/volute/commit/3694523bbcd6dfc641511e8b207ebf061297d336))

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
