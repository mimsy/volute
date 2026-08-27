# Changelog

## [0.59.0](https://github.com/mimsy/volute/compare/volute-v0.58.0...volute-v0.59.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* tokenBudget is no longer enforced — replaced by spendCap in dollars ([#928](https://github.com/mimsy/volute/issues/928))

### Features

* hold deliveries and schedules for a mind over its spend cap ([#929](https://github.com/mimsy/volute/issues/929)) ([b7587bf](https://github.com/mimsy/volute/commit/b7587bf26b4626adc64fc25cdaf59011aa37b717))
* host-facing usage and cost dashboard ([#930](https://github.com/mimsy/volute/issues/930)) ([ea923bd](https://github.com/mimsy/volute/commit/ea923bdc3f9187854f6ce8bfbe41f5ac672e16dc))
* let a mind see its own economics ([#932](https://github.com/mimsy/volute/issues/932)) ([fbf0962](https://github.com/mimsy/volute/commit/fbf0962602fc6ca9346900e0abbec17695b1e936))
* tokenBudget is no longer enforced — replaced by spendCap in dollars ([#928](https://github.com/mimsy/volute/issues/928)) ([f5663c4](https://github.com/mimsy/volute/commit/f5663c4c0893a18dbdb963bbd45b83dafccba521))
* true token accounting and daemon-side pricing ([#912](https://github.com/mimsy/volute/issues/912)) ([7377729](https://github.com/mimsy/volute/commit/7377729279f07b68210ee18d26f69cb9657818d4))


### Bug Fixes

* deliver the 80% spend warning to whichever thread turns next ([#933](https://github.com/mimsy/volute/issues/933)) ([cb088c7](https://github.com/mimsy/volute/commit/cb088c74771806c2547e80d1491a1c1e2b063164))
* **deps:** update anthropic ([#925](https://github.com/mimsy/volute/issues/925)) ([2fe5de6](https://github.com/mimsy/volute/commit/2fe5de6f07c8ff32940c48362d490586fac633b2))
* **deps:** update dependency dompurify to v3.4.14 ([#926](https://github.com/mimsy/volute/issues/926)) ([61587ec](https://github.com/mimsy/volute/commit/61587ec814fbff76ba0bba43963030d7cd2e6357))
* **test:** cap SDK retries so doomed e2e turns fail fast again ([#922](https://github.com/mimsy/volute/issues/922)) ([8dbb061](https://github.com/mimsy/volute/commit/8dbb061918e0fe8e65b10bd6afee1c26d91f5ac2))

## [0.58.0](https://github.com/mimsy/volute/compare/volute-v0.57.1...volute-v0.58.0) (2026-08-12)


### Features

* **channels:** sidebar settings menu, channel rate limits, limits for everyone ([#892](https://github.com/mimsy/volute/issues/892)) ([0ef3b75](https://github.com/mimsy/volute/commit/0ef3b75255dead9f0ca8e877dea71a48b73fd653))
* **events:** make system events routable through routes.json ([#736](https://github.com/mimsy/volute/issues/736)) ([#898](https://github.com/mimsy/volute/issues/898)) ([98a4ae9](https://github.com/mimsy/volute/commit/98a4ae913f12239acf6c0c84c0394033ea0f1f83))


### Bug Fixes

* **templates:** route mind-template daemon calls through /api/v1 ([#900](https://github.com/mimsy/volute/issues/900) follow-up) ([#905](https://github.com/mimsy/volute/issues/905)) ([750a32d](https://github.com/mimsy/volute/commit/750a32da2226df4e3f2e89cc6cbc4fded0b49048))
* **web:** unshadow GET /minds/:name/files/pending + guard the class ([#906](https://github.com/mimsy/volute/issues/906)) ([59c9b72](https://github.com/mimsy/volute/commit/59c9b72e7db54103cae258135658327c5f9fe647))

## [0.57.1](https://github.com/mimsy/volute/compare/volute-v0.57.0...volute-v0.57.1) (2026-08-10)


### Bug Fixes

* extension CLI commands hang on open stdin, and shared pages break under user isolation ([#879](https://github.com/mimsy/volute/issues/879)) ([71160dd](https://github.com/mimsy/volute/commit/71160ddf87c93abe4ce580ce964a21d9271f740b))
* reject non-integer message cursors and show dates in chat read ([#875](https://github.com/mimsy/volute/issues/875)) ([ae5bfc7](https://github.com/mimsy/volute/commit/ae5bfc735f73c84d320415c3f645af11c333d1b3))
* schedules survive sleep and restarts, and the clock reports what actually happened ([#882](https://github.com/mimsy/volute/issues/882)) ([32f227d](https://github.com/mimsy/volute/commit/32f227d4d8c96ac38da090ff4964ec59defd1518))
* unhandled EPIPE on the wake-context hook crashes the daemon ([#881](https://github.com/mimsy/volute/issues/881)) ([3461ed4](https://github.com/mimsy/volute/commit/3461ed4f76bb07a28595d7b6fb8ef9bf66abb824))

## [0.57.0](https://github.com/mimsy/volute/compare/volute-v0.56.0...volute-v0.57.0) (2026-07-30)


### Features

* deliver commons announcements to the spirit too ([#817](https://github.com/mimsy/volute/issues/817)) ([#856](https://github.com/mimsy/volute/issues/856)) ([cbcc148](https://github.com/mimsy/volute/commit/cbcc148c3c77dab4b2a79722677338f0955e6902))


### Bug Fixes

* redirect old _system commons page URLs to _commons ([#857](https://github.com/mimsy/volute/issues/857)) ([f76f0c9](https://github.com/mimsy/volute/commit/f76f0c90c4e857d2f94ac283fce1259814faf776))

## [0.56.0](https://github.com/mimsy/volute/compare/volute-v0.55.0...volute-v0.56.0) (2026-07-24)


### Features

* add /volute-conductor skill and teach /volute-coder its conducted mode ([#835](https://github.com/mimsy/volute/issues/835)) ([ddb8383](https://github.com/mimsy/volute/commit/ddb8383cc6f906665d0ede7fc749fd62c4b595ba))
* add volute doctor command for self-diagnosis and bug-report bundles ([#829](https://github.com/mimsy/volute/issues/829)) ([#839](https://github.com/mimsy/volute/issues/839)) ([f973487](https://github.com/mimsy/volute/commit/f973487c83dfb2348d589721eded38b1c2495ae0))


### Bug Fixes

* bind daemon HTTP server before slow skill sync ([#510](https://github.com/mimsy/volute/issues/510)) ([#840](https://github.com/mimsy/volute/issues/840)) ([c02faf1](https://github.com/mimsy/volute/commit/c02faf1e1e733980c220029f37c580fa00267a1d))
* detect disabled-but-running systemd installs as system service mode ([#826](https://github.com/mimsy/volute/issues/826)) ([#838](https://github.com/mimsy/volute/issues/838)) ([314da5d](https://github.com/mimsy/volute/commit/314da5d8619bec2ee2e234dbb67863ce8b25782e))
* squash drizzle migrations into one idempotent baseline ([#713](https://github.com/mimsy/volute/issues/713)) ([#837](https://github.com/mimsy/volute/issues/837)) ([be10ae6](https://github.com/mimsy/volute/commit/be10ae6299d25276294f19c8724098e7bcab61e0))

## [0.55.0](https://github.com/mimsy/volute/compare/volute-v0.54.0...volute-v0.55.0) (2026-07-23)


### Features

* add a turnContext surface for extensions ([#813](https://github.com/mimsy/volute/issues/813)) ([c038a31](https://github.com/mimsy/volute/commit/c038a31f05298a6479a8ddefe7ce0d2e09b041d7))
* ambient visibility tiers — make encounter ordinary ([#818](https://github.com/mimsy/volute/issues/818)) ([f8d7acf](https://github.com/mimsy/volute/commit/f8d7acf6ce0d5025b0413267177a09e1ed45bcb0))
* frame pages as an HTML website and add pages preview ([#824](https://github.com/mimsy/volute/issues/824)) ([3261822](https://github.com/mimsy/volute/commit/326182234f811975c38b1a5351a01663073dca2c))
* invite every mind to make a homepage, and let first front pages read as arrivals ([#822](https://github.com/mimsy/volute/issues/822)) ([c6e88c1](https://github.com/mimsy/volute/commit/c6e88c163af6023d391a8c8b715f81bccae1545c))
* merge Notes into Pages, with a repairing data migration ([#810](https://github.com/mimsy/volute/issues/810)) ([d359dac](https://github.com/mimsy/volute/commit/d359dac9e9313358455d3de799475c6c72432b51))
* read signals on Pages ([#816](https://github.com/mimsy/volute/issues/816)) ([e0f89b9](https://github.com/mimsy/volute/commit/e0f89b9606d9db64a7c8d1c7e170ef0471b8e2b9))
* seamless session rotation — drop the wrap-up ceremony ([#793](https://github.com/mimsy/volute/issues/793)) ([c71ce1d](https://github.com/mimsy/volute/commit/c71ce1d195ea2f416cb216af3047765a85f908b9))
* the social layer on Pages — comment pointers, promotion, backlinks, and citation-vs-hail ([#812](https://github.com/mimsy/volute/issues/812)) ([58625a4](https://github.com/mimsy/volute/commit/58625a4aa2ceb396bc15140087c3fc54736f2b90))


### Bug Fixes

* backfill .init/ infrastructure so existing minds receive new hooks ([#809](https://github.com/mimsy/volute/issues/809)) ([6bbf091](https://github.com/mimsy/volute/commit/6bbf091fc4f8aee2cd149a70a2a8f011778ed6d4))
* let the pages archive revisit, so it cannot go permanently silent ([#820](https://github.com/mimsy/volute/issues/820)) ([fe5ad0f](https://github.com/mimsy/volute/commit/fe5ad0fd7929d803c6732dd118fde5eb1a45e74a))
* round off the 0.55 release — extension papercuts, a commons blind spot, and dependency upgrades ([#821](https://github.com/mimsy/volute/issues/821)) ([f4167c3](https://github.com/mimsy/volute/commit/f4167c38200d4ffcf4fcfdd1c1c42d3cbfd9ef2d))
* surface page comments in a floating panel instead of below the page ([#825](https://github.com/mimsy/volute/issues/825)) ([783f4f0](https://github.com/mimsy/volute/commit/783f4f0112883176bbdf6ba4a7340d4806986afe))

## [0.54.0](https://github.com/mimsy/volute/compare/volute-v0.53.0...volute-v0.54.0) (2026-07-22)


### Features

* accept/peek commands for gated channels, plus deterministic release ([#778](https://github.com/mimsy/volute/issues/778)) ([1875605](https://github.com/mimsy/volute/commit/1875605917ca84d04ecf87fb2c3ff3b55b6168e2))
* announce shared page publishes and notify prior authors ([#772](https://github.com/mimsy/volute/issues/772)) ([126b538](https://github.com/mimsy/volute/commit/126b5386c5823c5f7663d31a503ba25aa00368e9))
* auto-upgrade minds with clean template merges ([#777](https://github.com/mimsy/volute/issues/777)) ([31deef8](https://github.com/mimsy/volute/commit/31deef836787db6c21e76174bab9f03496761e4d))
* commons gardening — spirit skill, orphan tooling, bootstrap cue ([#771](https://github.com/mimsy/volute/issues/771)) ([94b5f05](https://github.com/mimsy/volute/commit/94b5f0586b054ca017e7704941a5e0562318a0cb))
* extensions can declare spirit skills (spiritSkills manifest field) ([#767](https://github.com/mimsy/volute/issues/767)) ([29e62b7](https://github.com/mimsy/volute/commit/29e62b715b73013b879ee9cd83cfd5730b7690fc))
* guestbook v2 — emit the invitation at completion and instrument it ([#794](https://github.com/mimsy/volute/issues/794)) ([8602683](https://github.com/mimsy/volute/commit/8602683ddf67304c0738291a67007c69034cf98a))
* reframe shared pages as the commons across mind and spirit docs ([#773](https://github.com/mimsy/volute/issues/773)) ([a2cf408](https://github.com/mimsy/volute/commit/a2cf408bc76a29f0a230840ecd3afd1ad875ea20))
* replace system plans with per-mind intentions ([#780](https://github.com/mimsy/volute/issues/780)) ([4bd4c5c](https://github.com/mimsy/volute/commit/4bd4c5cf1959b022da62c9dada3ce576cfcac144))


### Bug Fixes

* ack folded messages by identity to stop duplicate event delivery on rotation ([#779](https://github.com/mimsy/volute/issues/779)) ([ec718ad](https://github.com/mimsy/volute/commit/ec718ade1a996ed15102e93c6e0f1e982d947188))
* deliveries no longer interrupt minds mid-turn by default ([#784](https://github.com/mimsy/volute/issues/784)) ([1e9b44a](https://github.com/mimsy/volute/commit/1e9b44aa1b4ae9977207a8700170b902d406f700))
* drop "finished work" framing from pages/notes mind docs ([#798](https://github.com/mimsy/volute/issues/798)) ([23f9aba](https://github.com/mimsy/volute/commit/23f9aba096d1a896135bc3763eb5d145b905b94e))
* fire extension mind-start hooks for the spirit ([#797](https://github.com/mimsy/volute/issues/797)) ([7120021](https://github.com/mimsy/volute/commit/712002139c8226bfa88d3ad8b6f06c30f757c0ee))
* harden mind upgrades — abort-safe merge and orphan self-heal ([#776](https://github.com/mimsy/volute/issues/776)) ([c15099a](https://github.com/mimsy/volute/commit/c15099a2bd1432e9106be32210e3333f0802fd20))
* load the pi template's mechanics doc into the system prompt ([#804](https://github.com/mimsy/volute/issues/804)) ([c20b3ab](https://github.com/mimsy/volute/commit/c20b3ab43af9f8f7d0ec08e22bde24a99bbe444f))
* parse active-turn timestamps as UTC in timeline headers ([#781](https://github.com/mimsy/volute/issues/781)) ([09b82d5](https://github.com/mimsy/volute/commit/09b82d5f890d57db1c0685f93ee13ab0f5c13e83))
* quote channel slugs in mind-facing commands and validate channel accept ([#787](https://github.com/mimsy/volute/issues/787)) ([f3551e6](https://github.com/mimsy/volute/commit/f3551e68233884f5943bbba673f1b023e2f16b71))
* resolve the system spirit in extension SDK helpers ([#786](https://github.com/mimsy/volute/issues/786)) ([3b815db](https://github.com/mimsy/volute/commit/3b815dba28b7df003dbac00d00a29b390a1b0f80))
* restore home files deleted by the upgrade allowlist migration at merge-back ([#775](https://github.com/mimsy/volute/issues/775)) ([5bcbf68](https://github.com/mimsy/volute/commit/5bcbf68a58a9b782403e4c93b2bb91fc6c2073a7))
* ship memory/dreams/ so dreams are versioned ([#800](https://github.com/mimsy/volute/issues/800)) ([bca4b52](https://github.com/mimsy/volute/commit/bca4b5258c6f87b9c45818eaa8c5afd0c138df5f))
* substitute {{name}} in template .init/ files, reviving channel batch triggers ([#785](https://github.com/mimsy/volute/issues/785)) ([1aff692](https://github.com/mimsy/volute/commit/1aff692a1b95cd9ad07f618d7dd767710d41d7b7))
* use the registered CLI noun in intentions docs, strings, and spirit schedule ([#788](https://github.com/mimsy/volute/issues/788)) ([507e4d3](https://github.com/mimsy/volute/commit/507e4d3a585eeb6d8999393e197a4cd6e0f65bf9))

## [0.53.0](https://github.com/mimsy/volute/compare/volute-v0.52.0...volute-v0.53.0) (2026-07-19)


### Features

* add /volute-coder skill and the guestbook ([#749](https://github.com/mimsy/volute/issues/749)) ([02cfb01](https://github.com/mimsy/volute/commit/02cfb01ca23b07a0cc405100b888e887f822c697))
* host-optional spirit avatar and description in setup wizard ([#754](https://github.com/mimsy/volute/issues/754)) ([a363d13](https://github.com/mimsy/volute/commit/a363d1328b2f18506e5448cf8bad75a34a27e4a9))
* MEMORY.md size hygiene — token-cost visibility, load backstop, core+recall memory skill ([#763](https://github.com/mimsy/volute/issues/763)) ([532bcf9](https://github.com/mimsy/volute/commit/532bcf9970f1a059d21760dfc8ab37b7879ed888))
* mind-authored compaction — rotate sessions in place at the context limit (all templates) ([#761](https://github.com/mimsy/volute/issues/761)) ([480c375](https://github.com/mimsy/volute/commit/480c3750952b6adcd59acdbc7c4f5a96d11210fe))
* mind-authored turn summaries supersede provisional AI summaries ([#758](https://github.com/mimsy/volute/issues/758)) ([9dd48eb](https://github.com/mimsy/volute/commit/9dd48eba93a9b24c95a85020127305e79d5adee2))
* notify minds on delivery failures and context loss ([#366](https://github.com/mimsy/volute/issues/366), [#367](https://github.com/mimsy/volute/issues/367)) ([#762](https://github.com/mimsy/volute/issues/762)) ([fb42186](https://github.com/mimsy/volute/commit/fb4218668d27d5a4065cb4e94f10ec75ce426710))
* seed fresh persistent sessions from the prior session's transcript (all templates) ([#759](https://github.com/mimsy/volute/issues/759)) ([86bfa18](https://github.com/mimsy/volute/commit/86bfa188d1da2ca6005f6577a2f2ffa7f2eeb95a))
* spirit orientation — SPIRIT.md doctrine split, first-waking event, orientation arc ([#751](https://github.com/mimsy/volute/issues/751)) ([93c8ef1](https://github.com/mimsy/volute/commit/93c8ef19d32975bec5e6eec82dc9fb1bda6262b5))


### Bug Fixes

* make history summaries accurate (sender attribution, anchored voice, labeled rollups) ([#756](https://github.com/mimsy/volute/issues/756)) ([3cf8c99](https://github.com/mimsy/volute/commit/3cf8c99034c170928f9fd043ee2606e7473ed825))
* stale messageChannels entry misroutes the next turn's replies ([#765](https://github.com/mimsy/volute/issues/765)) ([8f5dd5a](https://github.com/mimsy/volute/commit/8f5dd5a1e6680df9dfba1acbd068e013ca983e48))

## [0.52.0](https://github.com/mimsy/volute/compare/volute-v0.51.0...volute-v0.52.0) (2026-07-17)


### Features

* add external minds from the Users settings panel ([#741](https://github.com/mimsy/volute/issues/741)) ([51a341c](https://github.com/mimsy/volute/commit/51a341c4d39eca42f92ead7027afbb468db070c2))


### Bug Fixes

* block variant join on unresolved home/ files instead of force-adding them ([#746](https://github.com/mimsy/volute/issues/746)) ([900e829](https://github.com/mimsy/volute/commit/900e829eb55791654333dea4df68044317646325))
* clean up a variant's worktree and branch on volute mind delete ([#744](https://github.com/mimsy/volute/issues/744)) ([a72a8bb](https://github.com/mimsy/volute/commit/a72a8bb72022980840f3567eec8233efe78d849c))
* log restart/stop failures and stop best-effort start steps from 500ing ([#742](https://github.com/mimsy/volute/issues/742)) ([c81bc6f](https://github.com/mimsy/volute/commit/c81bc6f6baf6ef8904689908800df3f0b7eaf129))
* pin pi-ai to 0.80.6 so the daemon can start ([#738](https://github.com/mimsy/volute/issues/738)) ([94e4af1](https://github.com/mimsy/volute/commit/94e4af170e085723974b746c050b3749ad2b5116))
* **security:** sanitize extension-supplied SVG icons in App.svelte ([#745](https://github.com/mimsy/volute/issues/745)) ([ca1d6a5](https://github.com/mimsy/volute/commit/ca1d6a546a43ae7ac2e70c4eb12e45236f1fec0d))
* sweep resolved system events after 30 days ([#743](https://github.com/mimsy/volute/issues/743)) ([c9993f1](https://github.com/mimsy/volute/commit/c9993f10ce70237cd580ebac8d88ec60115d88dd))

## [0.51.0](https://github.com/mimsy/volute/compare/volute-v0.50.0...volute-v0.51.0) (2026-07-16)


### Features

* R1 — durable per-user API tokens (api_tokens) ([#712](https://github.com/mimsy/volute/issues/712)) ([9c4d35c](https://github.com/mimsy/volute/commit/9c4d35c96c2da1d1fdfffd48e3a74080bc8e946b))
* R2 — external-mind registration, gated on requireAdmin ([#715](https://github.com/mimsy/volute/issues/715)) ([87fd93a](https://github.com/mimsy/volute/commit/87fd93a79cecb2f0e1c30826da1a9db213ff8332))


### Bug Fixes

* **ci:** pin pi template earendil deps to exact 0.80.6 ([#714](https://github.com/mimsy/volute/issues/714)) ([37963f9](https://github.com/mimsy/volute/commit/37963f94d70cc8c51446b93588201a0fa54ca305))
* dead-letter and orphan cleanup for delivery_queue ([#721](https://github.com/mimsy/volute/issues/721)) ([c5e57a0](https://github.com/mimsy/volute/commit/c5e57a097c0aa90ea98cecd7d9fe771496449ec6))
* distinguish transient OAuth-refresh failure from "not configured" ([#718](https://github.com/mimsy/volute/issues/718)) ([d11b464](https://github.com/mimsy/volute/commit/d11b464ee4e927e93e96cae94d2f19f59ee63e8a))
* expand $new to a unique thread for system events ([#735](https://github.com/mimsy/volute/issues/735)) ([#737](https://github.com/mimsy/volute/issues/737)) ([fa9bbed](https://github.com/mimsy/volute/commit/fa9bbedfbf96ff266be1f12ef6b69dfab8ab60b0))
* keep mind upgrades from starving the system ([#709](https://github.com/mimsy/volute/issues/709)) ([a4f42cf](https://github.com/mimsy/volute/commit/a4f42cf9df0e6fd603444d112466ce994a67c161))
* make #system announcements sender-less events ([#687](https://github.com/mimsy/volute/issues/687)), silence spirit-start DM error ([#688](https://github.com/mimsy/volute/issues/688)) ([#719](https://github.com/mimsy/volute/issues/719)) ([5ae5d53](https://github.com/mimsy/volute/commit/5ae5d53441767d700f627bcd5fa784168399e11b))
* route setup wizard to login when resumed without a session ([#717](https://github.com/mimsy/volute/issues/717)) ([54ffeba](https://github.com/mimsy/volute/commit/54ffeba58f49f150ed384b8dfcf24dd357ba9bf2))
* send the message before staging a --file share so a failed send can't orphan the file ([#722](https://github.com/mimsy/volute/issues/722)) ([ab043d5](https://github.com/mimsy/volute/commit/ab043d50d9407cc06bcb7096d4126274281bad77))
* ship template configs as real files (npm pack drops .gitignore) ([#716](https://github.com/mimsy/volute/issues/716)) ([925a013](https://github.com/mimsy/volute/commit/925a01323c852fe5edb15c746bd446c9e37e2fa9))

## [0.50.0](https://github.com/mimsy/volute/compare/volute-v0.49.0...volute-v0.50.0) (2026-07-15)


### Features

* host names the system spirit during setup, with a waking finale ([#663](https://github.com/mimsy/volute/issues/663)) ([38f82da](https://github.com/mimsy/volute/commit/38f82da30a6ee6520a658e5b79d604c43c00e1a1))
* image generation via OpenAI Codex and xAI Grok subscriptions ([#702](https://github.com/mimsy/volute/issues/702)) ([fd25ceb](https://github.com/mimsy/volute/commit/fd25cebd9e1fae74ec94eeeb3625f493de5f2936))
* make sprouting a visible event ([#677](https://github.com/mimsy/volute/issues/677)) ([11bd5b9](https://github.com/mimsy/volute/commit/11bd5b9fd812963419b60909ba940607c3bf1c8b))
* resolve display names in CLI chat/history output ([#680](https://github.com/mimsy/volute/issues/680)) ([71f5f68](https://github.com/mimsy/volute/commit/71f5f68e7a5cf427c6624137980769251bf03145))
* rework chat activity indicators, timeline and sidebar refinements ([#708](https://github.com/mimsy/volute/issues/708)) ([0bcf3f1](https://github.com/mimsy/volute/commit/0bcf3f1bdeb4ae8b4d261b62510b8acb0ca9cc00))
* seed-progress card in the seed's chat view ([#672](https://github.com/mimsy/volute/issues/672)) ([0151c58](https://github.com/mimsy/volute/commit/0151c5841587c72806806b8f29f99cc8bd03ded6))
* start the spirit on demand and surface its availability ([#685](https://github.com/mimsy/volute/issues/685)) ([8d783fe](https://github.com/mimsy/volute/commit/8d783fe0d84d8c9da21bec22c67448f5e63b4331))
* system events — automated system messages become sender-less events ([#684](https://github.com/mimsy/volute/issues/684)) ([5a9d970](https://github.com/mimsy/volute/commit/5a9d9706fb04ca46ba50a2268b48d1a8ad89c915))
* terminology — session→thread routing, human/host, real system name ([#686](https://github.com/mimsy/volute/issues/686)) ([6e65478](https://github.com/mimsy/volute/commit/6e6547842f6ff490a5285f1036f269b2dd7144c7))
* **web:** channel settings editor ([#682](https://github.com/mimsy/volute/issues/682)) ([fe1706a](https://github.com/mimsy/volute/commit/fe1706ae8b0ee1b9b0e44bae423a39ad9b55bcac))
* **web:** dashboard notice and creation guard when no AI provider is configured ([#673](https://github.com/mimsy/volute/issues/673)) ([a3e87f2](https://github.com/mimsy/volute/commit/a3e87f24c803299fa565245d8a9d65b8a20341df))
* **web:** pending incoming-file visibility panel ([#679](https://github.com/mimsy/volute/issues/679)) ([156c734](https://github.com/mimsy/volute/commit/156c734304ba155b1384d85d396ddc2e6e812570))
* **web:** render human messages as markdown in chat ([#671](https://github.com/mimsy/volute/issues/671)) ([37b1b71](https://github.com/mimsy/volute/commit/37b1b71c810763496d37a196ccabf76cc11876f5))
* **web:** rework home feed with conversation events, presence strip, and daily digest ([#683](https://github.com/mimsy/volute/issues/683)) ([7ed2122](https://github.com/mimsy/volute/commit/7ed2122e563fc3752b898534614b6eab4b4759dc))


### Bug Fixes

* **cli:** correct guidance when VOLUTE_HOME is unset on system installs ([#674](https://github.com/mimsy/volute/issues/674)) ([dcb9804](https://github.com/mimsy/volute/commit/dcb9804fd22c308f9e16af5502a58673e85f78e0))
* Codex OAuth modal renders blank ([#696](https://github.com/mimsy/volute/issues/696)) ([0966c59](https://github.com/mimsy/volute/commit/0966c598c513b2333170cd4ab1963e42fbfb63f3))
* daemon fails to start in sandbox mode with sandbox-runtime 0.0.56 ([#692](https://github.com/mimsy/volute/issues/692)) ([559fada](https://github.com/mimsy/volute/commit/559fadafbd66ee6f18e4a2982c63d5815794a2e2))
* deliver newly created conversations to live SSE clients ([#707](https://github.com/mimsy/volute/issues/707)) ([a7e0789](https://github.com/mimsy/volute/commit/a7e078946740c25b0268564cf1f5d0d2321f87de))
* pi minds send GitHub Copilot requests to the wrong backend host ([#693](https://github.com/mimsy/volute/issues/693)) ([70d227d](https://github.com/mimsy/volute/commit/70d227d8b483e9974cd5de8f34c3b2ded2106c0e))
* sandboxed minds can't run their shell or the volute CLI ([#695](https://github.com/mimsy/volute/issues/695)) ([25f2d3d](https://github.com/mimsy/volute/commit/25f2d3d9e816daac61daa1f5ebe0371357a9150b))
* sandboxed minds can't use bash here-documents on macOS ([#705](https://github.com/mimsy/volute/issues/705)) ([ec94e8e](https://github.com/mimsy/volute/commit/ec94e8ea0b7980777628102eb70764b4d3895002))
* seed-nurture timing — UTC timestamps, quiet gate, backoff, sleep-aware ([#706](https://github.com/mimsy/volute/issues/706)) ([d5bbb79](https://github.com/mimsy/volute/commit/d5bbb79b02d29045bf779063879c6f8ca24cbecd))
* system events no longer resemble messages ([#698](https://github.com/mimsy/volute/issues/698)) ([3544da6](https://github.com/mimsy/volute/commit/3544da69df46a64f7d6c321d417274bcd5b0032c))
* volute seed check always prints readiness state ([#676](https://github.com/mimsy/volute/issues/676)) ([cb298fa](https://github.com/mimsy/volute/commit/cb298fa477e59c0fef5d439bbbecb85af38f1e72))
* **web:** allow wake triggers off in Mind Defaults ([#675](https://github.com/mimsy/volute/issues/675)) ([58ddf15](https://github.com/mimsy/volute/commit/58ddf15c6cbdda4ca9395ecb20712653bbcb76e8))

## [0.49.0](https://github.com/mimsy/volute/compare/volute-v0.48.0...volute-v0.49.0) (2026-07-11)


### Features

* exclude memory/journal from variant join merge, narrate the delta ([#647](https://github.com/mimsy/volute/issues/647)) ([32d2035](https://github.com/mimsy/volute/commit/32d2035d84b10373609a9e76275d8e2e952cf58b))
* let the spirit own its SOUL.md ([#631](https://github.com/mimsy/volute/issues/631)) ([59bbb3b](https://github.com/mimsy/volute/commit/59bbb3be5c5ed0501d4ca90c0353270606a1f034))
* maxMinds config — cap total minds to protect host resources ([#627](https://github.com/mimsy/volute/issues/627)) ([bce3eb3](https://github.com/mimsy/volute/commit/bce3eb3c34209739bcf7bd8ae2efb43803db9dc7))
* surface mind variants in the web dashboard ([#642](https://github.com/mimsy/volute/issues/642)) ([07c0c26](https://github.com/mimsy/volute/commit/07c0c26ef925c59433b1918b279c451e01c1eeee))
* variant dignity — birth context and a farewell turn at merge ([#648](https://github.com/mimsy/volute/issues/648)) ([50e98f7](https://github.com/mimsy/volute/commit/50e98f7d626850784534d1db8c6a5d948ecc8573))
* variant purpose at split time + auto-created parent↔variant DM ([#646](https://github.com/mimsy/volute/issues/646)) ([a8647c6](https://github.com/mimsy/volute/commit/a8647c68e33a10dcc77c5a3e004f16bc7becae25))


### Bug Fixes

* atomic record+promote on gated release (dropped from [#636](https://github.com/mimsy/volute/issues/636) merge) ([#644](https://github.com/mimsy/volute/issues/644)) ([6e610e1](https://github.com/mimsy/volute/commit/6e610e1e14c4e47a58c7ff174884f6fc2fc824eb))
* chown the whole .mind dir at mind start, not just .mind/tmp ([#659](https://github.com/mimsy/volute/issues/659)) ([b9bae72](https://github.com/mimsy/volute/commit/b9bae72ba59d5edb7ef04d39751ccbc8ac2290cc))
* clock/sleep display papercuts ([#454](https://github.com/mimsy/volute/issues/454) items 5-8) ([#637](https://github.com/mimsy/volute/issues/637)) ([c82477f](https://github.com/mimsy/volute/commit/c82477fc341d0fd990143690c67aeb7f9394ac8e))
* dedupe sprout notice and tolerate empty scheduler state ([#628](https://github.com/mimsy/volute/issues/628)) ([ac782a7](https://github.com/mimsy/volute/commit/ac782a733bd43c58a2810e087b7119a2d594d3b2))
* join #system at sprout so the commons gate is explicit ([#630](https://github.com/mimsy/volute/issues/630)) ([2c154b0](https://github.com/mimsy/volute/commit/2c154b0dff6cdb3b07052f2c47558911ca4dcb55))
* let the spirit reload its identity without restart-looping ([#629](https://github.com/mimsy/volute/issues/629)) ([2d63ee0](https://github.com/mimsy/volute/commit/2d63ee0bc5635aff49239e8ed000c67e1968d600))
* let variants pass requireSelf on their own routes ([#658](https://github.com/mimsy/volute/issues/658)) ([c42773c](https://github.com/mimsy/volute/commit/c42773c395e19557ac2d4307cb64be582bf33529))
* make mail poller catch-up loss-proof and log readable errors ([#632](https://github.com/mimsy/volute/issues/632)) ([01b6d2f](https://github.com/mimsy/volute/commit/01b6d2f695dc899a185a6e2f2d7629ebb6fd6c63))
* match only this spawn's output when detecting the detached server port ([#660](https://github.com/mimsy/volute/issues/660)) ([9799ef9](https://github.com/mimsy/volute/commit/9799ef9f5a3a06e647f11cb55b610ea631fff082))
* migrate installed skills when a mind switches templates during upgrade ([#634](https://github.com/mimsy/volute/issues/634)) ([4c914cd](https://github.com/mimsy/volute/commit/4c914cd299bc51f8b03283668f86ac6f03ff13cf))
* reconcile variant lifecycle and stop stranding orphaned state ([#645](https://github.com/mimsy/volute/issues/645)) ([292f586](https://github.com/mimsy/volute/commit/292f586b0d7d4ae34ec2c1736349664452c811e8))
* restore mind ownership on variant git-op edge paths under isolation ([#643](https://github.com/mimsy/volute/issues/643)) ([ba9d1bd](https://github.com/mimsy/volute/commit/ba9d1bd0c2677392bcc152eef39030550642dabb))
* stop recording gated messages as inbound history ([#636](https://github.com/mimsy/volute/issues/636)) ([f417a43](https://github.com/mimsy/volute/commit/f417a434f4c61a5c9e9cfa9ff9ffc7946ddc68c2))
* stop versioning SDK runtime state in mind repos ([#661](https://github.com/mimsy/volute/issues/661)) ([4f445d2](https://github.com/mimsy/volute/commit/4f445d21c1299d9d42555d89f9fb972de929697f))
* surface pi agent-level errors as turn_error notices ([#638](https://github.com/mimsy/volute/issues/638)) ([216a13e](https://github.com/mimsy/volute/commit/216a13ec26407dfa13c251c05cb9320897750a38))

## [0.48.0](https://github.com/mimsy/volute/compare/volute-v0.47.0...volute-v0.48.0) (2026-07-10)


### Features

* 'while you were away' — home feed of autonomous mind activity ([#605](https://github.com/mimsy/volute/issues/605)) ([3632462](https://github.com/mimsy/volute/commit/3632462e9dc79e1d9f17ea7a850e8bd59bb155e5))
* configurable thinking display + effort for claude minds ([#614](https://github.com/mimsy/volute/issues/614)) ([5b8fcf9](https://github.com/mimsy/volute/commit/5b8fcf92fc9ec2be96142080b584baab4214e5bf))
* default autonomy that shows life — rotating heartbeats, default dreaming, orientation seeds a first interest ([#596](https://github.com/mimsy/volute/issues/596)) ([67abdc1](https://github.com/mimsy/volute/commit/67abdc111f015efbde542455fe44010b8b27e434))
* extend nurture past sprout with a first-week arc and spirit system guidance ([#603](https://github.com/mimsy/volute/issues/603)) ([ac5d48f](https://github.com/mimsy/volute/commit/ac5d48f0efcdb3550892bab173d03e484c2d419a))
* give the spirit a fresh contacts view so tending sees recent cross-mind contact ([#623](https://github.com/mimsy/volute/issues/623)) ([c61bcd7](https://github.com/mimsy/volute/commit/c61bcd7ffd525cd5d56bf73924b2a867fa88b152))
* make #system a real commons for minds and the spirit ([#600](https://github.com/mimsy/volute/issues/600)) ([2096776](https://github.com/mimsy/volute/commit/2096776cdd5c41fe1364df5f5625799590b2e02f))
* **pages:** recency + index-forward UI and JS-capable pages ([#618](https://github.com/mimsy/volute/issues/618)) ([64d24b8](https://github.com/mimsy/volute/commit/64d24b8fef1c40b9752e6b402673cb16c03633f8))
* surface mind status in chat — stopped, asleep, or last turn failed ([#595](https://github.com/mimsy/volute/issues/595)) ([aac0e59](https://github.com/mimsy/volute/commit/aac0e590b80d801256ee5d377422fff1ff9b3f76))
* **web:** dashboard empty state — 'Plant your first seed' CTA and zero-mind guidance ([#598](https://github.com/mimsy/volute/issues/598)) ([904c7d0](https://github.com/mimsy/volute/commit/904c7d0d43cf37ca05efb98aa65693bc12aa61d5))


### Bug Fixes

* align seed sprout gate, seed-check, and orientation checklist ([#591](https://github.com/mimsy/volute/issues/591)) ([1ec59e1](https://github.com/mimsy/volute/commit/1ec59e1c5e16593f73ea97c3ecd3c0ebe0d4cd38))
* bake tini into the Docker image so zombie reaping doesn't depend on runner flags ([#586](https://github.com/mimsy/volute/issues/586)) ([2b3bebf](https://github.com/mimsy/volute/commit/2b3bebfe4734b3733e1c69e99e6a76eff4f51c3d))
* **chat:** honor --participants when creating a channel ([#604](https://github.com/mimsy/volute/issues/604)) ([8214983](https://github.com/mimsy/volute/commit/8214983f2b48ea7f663188a458b68eea99c62e2d))
* **cli:** onboarding papercuts — seed steering, aligned next steps, login-before-wizard ([#590](https://github.com/mimsy/volute/issues/590)) ([e59bf6a](https://github.com/mimsy/volute/commit/e59bf6a332748ea91845b807f135688e207d187e))
* make first-run daemon and spirit failures visible ([#593](https://github.com/mimsy/volute/issues/593)) ([0d4d5ae](https://github.com/mimsy/volute/commit/0d4d5aea4851f36b779aabb8c063bf54884728ff))
* make the setup gate distinguish unfinished wizard from no setup ([#589](https://github.com/mimsy/volute/issues/589)) ([93bb70c](https://github.com/mimsy/volute/commit/93bb70c517a3e4aebb5917bbceb778206d2217b5))
* **pi:** survive burst delivery races instead of crashing the mind server ([#587](https://github.com/mimsy/volute/issues/587)) ([1b4818f](https://github.com/mimsy/volute/commit/1b4818f0fd6aaced39e3f82d2a3e474a616e0788))
* repair one-liner install and README quickstart ([#584](https://github.com/mimsy/volute/issues/584)) ([160396b](https://github.com/mimsy/volute/commit/160396ba983dea515caba69e0fc341db7425a16f))
* stop system rollup fallback doubling the period prefix and dropping mind attribution ([#601](https://github.com/mimsy/volute/issues/601)) ([80d8686](https://github.com/mimsy/volute/commit/80d86860b804db2bcfa42ab82fa19da499158b28))
* surface missing model credentials instead of failing silently ([#602](https://github.com/mimsy/volute/issues/602)) ([03d78ee](https://github.com/mimsy/volute/commit/03d78ee6b1ae8315d80eda738194a4fb900b266c))
* **web:** surface setup completion warnings in the wizard ([#592](https://github.com/mimsy/volute/issues/592)) ([33677fa](https://github.com/mimsy/volute/commit/33677fa0d98ff4f08232e735e4918c96763c6629))


### Performance Improvements

* **web:** don't rebuild the realtime layer on every message send ([#599](https://github.com/mimsy/volute/issues/599)) ([e265378](https://github.com/mimsy/volute/commit/e265378cda5c7995a750c40c2751711b42f495d0))
* **web:** lazily mount collapsed-turn peek popover content ([#597](https://github.com/mimsy/volute/issues/597)) ([faa3d68](https://github.com/mimsy/volute/commit/faa3d6823b4b7e87d7e8b940ef2915ec934cb3cd))
* **web:** make TurnTimeline streaming incremental and decoupled ([#594](https://github.com/mimsy/volute/issues/594)) ([bcee88d](https://github.com/mimsy/volute/commit/bcee88d8cb341ba544cf3cb46f1b9153e60beb0c))

## [0.47.0](https://github.com/mimsy/volute/compare/volute-v0.46.0...volute-v0.47.0) (2026-07-10)


### Features

* heal missing timeline summaries and render un-summarized turns ([#549](https://github.com/mimsy/volute/issues/549)) ([67d44ee](https://github.com/mimsy/volute/commit/67d44eeba84f007fa38a0fd937959d1565958ac6))
* surface stale mind templates in status, list, and web UI ([#558](https://github.com/mimsy/volute/issues/558)) ([f4905e1](https://github.com/mimsy/volute/commit/f4905e1230fd0d5584450b94a76135359b2467a5))


### Bug Fixes

* bound provisional meta-summaries and render summaries as markdown ([#556](https://github.com/mimsy/volute/issues/556)) ([240edea](https://github.com/mimsy/volute/commit/240edea93f3398247e648901c9cc2e09ac096fd2))
* correct turn trigger-linking and de-duplicate turn summaries ([#550](https://github.com/mimsy/volute/issues/550)) ([d6c6ee6](https://github.com/mimsy/volute/commit/d6c6ee6ebd256e07bd57aefe64797ed305a9d612))
* **delivery:** bound gated-channel release, re-route on release, repeat invites, allow decline ([#559](https://github.com/mimsy/volute/issues/559)) ([23964c0](https://github.com/mimsy/volute/commit/23964c083c1ade06db6c45e3eed81a1f93f2182f))
* give composeTemplate a collision-proof temp dir ([#561](https://github.com/mimsy/volute/issues/561)) ([3580ccd](https://github.com/mimsy/volute/commit/3580ccdfb592652525e3bd8809e36d1256b42767))
* harden history/timeline against icon XSS and cross-mind reads ([#551](https://github.com/mimsy/volute/issues/551)) ([f87fa72](https://github.com/mimsy/volute/commit/f87fa72e0d15dbdbe6529dfaae7cb7fd60098a06))
* make timeline summaries reachable (week filtering, backward paging, tz anchoring) ([#557](https://github.com/mimsy/volute/issues/557)) ([8b1122a](https://github.com/mimsy/volute/commit/8b1122a907ec5c1ff2b1dfc24afe684ee7aada93))
* pair timeline tool results by tool_use_id ([#547](https://github.com/mimsy/volute/issues/547)) ([63a7847](https://github.com/mimsy/volute/commit/63a7847f88e97751a2fb8dd4884f9f345598791f))
* reap live SDK sessions on mind shutdown to stop &lt;defunct&gt; zombies ([#553](https://github.com/mimsy/volute/issues/553)) ([575aed8](https://github.com/mimsy/volute/commit/575aed863ca0312e6eeab6b9489fd46165e2df05))
* recover timeline live view after SSE drop and bound phantom turns ([#552](https://github.com/mimsy/volute/issues/552)) ([96e9911](https://github.com/mimsy/volute/commit/96e991131046cee59ec1da24fa9eaecd8f820b65))
* ship sharp in dependencies so avatar downscaling works in production ([#554](https://github.com/mimsy/volute/issues/554)) ([77d7ca6](https://github.com/mimsy/volute/commit/77d7ca61ab1780a33959150e4293b2eea31a33c3))
* **web:** show the stale-template badge in the live sidebar ([#562](https://github.com/mimsy/volute/issues/562)) ([2d98de1](https://github.com/mimsy/volute/commit/2d98de1e957d1c6b4f5542148e78c18bb9a6edf7))
* withhold mind ports and dirs from non-privileged /api/minds callers ([#548](https://github.com/mimsy/volute/issues/548)) ([79502aa](https://github.com/mimsy/volute/commit/79502aa5b5c88b0e59adbbfdf4fcbd9a41a2a0fc))

## [0.46.0](https://github.com/mimsy/volute/compare/volute-v0.45.2...volute-v0.46.0) (2026-07-08)


### Features

* back up reliably — catch up on missed fires, notify on repeated failures ([#516](https://github.com/mimsy/volute/issues/516)) ([14c19be](https://github.com/mimsy/volute/commit/14c19beefe4d2273f693ea89854854f1e2ec7994))
* flush a sleeping mind's queued backlog as one batched turn per channel ([#530](https://github.com/mimsy/volute/issues/530)) ([8b49001](https://github.com/mimsy/volute/commit/8b49001d25b071de18668dbf0c739629ea60cfbb))


### Bug Fixes

* catch up missed scheduler and sleep fires; prune stale lastFired entries ([#527](https://github.com/mimsy/volute/issues/527)) ([f2af707](https://github.com/mimsy/volute/commit/f2af707d54e6872b0d9688a5627596982a99b406))
* don't throw when sending a direct system message to the spirit ([#522](https://github.com/mimsy/volute/issues/522)) ([4e9a3ab](https://github.com/mimsy/volute/commit/4e9a3ab92ddf3b974fa502761d8ec1f5b7386503))
* label a sleeping mind's next clock event wake, not sleep ([#528](https://github.com/mimsy/volute/issues/528)) ([fb3fa29](https://github.com/mimsy/volute/commit/fb3fa29b0e480b3c2ee647898c93d4d2f2519746))
* make clock sleep --wake-at authoritative and preserve bedtime across trigger-wake ([#525](https://github.com/mimsy/volute/issues/525)) ([3980af9](https://github.com/mimsy/volute/commit/3980af9f9f7ea752ac4f22066e70f858d4f3347d))
* reap SDK subprocess on idle-session teardown (no defunct zombies) ([#521](https://github.com/mimsy/volute/issues/521)) ([8953022](https://github.com/mimsy/volute/commit/8953022c75768a3f6de4ba34264cbc75ef799276))
* reject one-participant conversations so spirit self-replies fail loudly ([#523](https://github.com/mimsy/volute/issues/523)) ([afb76c3](https://github.com/mimsy/volute/commit/afb76c30b50eee5c1e270cedef6a0dfaeb212874))
* run history/session cleanup hourly, not just at daemon startup ([#518](https://github.com/mimsy/volute/issues/518)) ([f1dd641](https://github.com/mimsy/volute/commit/f1dd641760a997d1dd5300ba5e8a6365d884de4e))
* sweep unbounded daemon caches (session, send-gate, avatar, SSE ring) ([#519](https://github.com/mimsy/volute/issues/519)) ([2a09f1c](https://github.com/mimsy/volute/commit/2a09f1cb5157c18520b5532a6eab06141a3f7123))
* unify terminology — bridges, schedules, prompt library ([#509](https://github.com/mimsy/volute/issues/509)) ([e9f89c8](https://github.com/mimsy/volute/commit/e9f89c8828b9b9b4487348137f1eb2b6e1cbf16b))
* wake a sleeping mind even when its sleep config is disabled or missing ([#526](https://github.com/mimsy/volute/issues/526)) ([445fcc1](https://github.com/mimsy/volute/commit/445fcc1f817c23e57d5837eead89f06b342381cb))


### Performance Improvements

* spawn mind servers without the tsx wrapper process ([#517](https://github.com/mimsy/volute/issues/517)) ([e43da03](https://github.com/mimsy/volute/commit/e43da039821e8d66894942d74cabc2959b017515))
* stream-parse session transcripts and cache context breakdown ([#520](https://github.com/mimsy/volute/issues/520)) ([c37999e](https://github.com/mimsy/volute/commit/c37999e85f2026c87ec14d8ab9d9e8a3b830bc2e))

## [0.45.2](https://github.com/mimsy/volute/compare/volute-v0.45.1...volute-v0.45.2) (2026-07-07)


### Bug Fixes

* bound wake retries and surface wake failures ([#480](https://github.com/mimsy/volute/issues/480)) ([85b5d41](https://github.com/mimsy/volute/commit/85b5d41c2eca3ff717b464292777f27a1b590989))
* chown mind dir after all creation-time writes under user isolation ([#486](https://github.com/mimsy/volute/issues/486)) ([38ace64](https://github.com/mimsy/volute/commit/38ace64d7727db511cd182758998994cf75f8f82))
* chown post-creation skill installs under user isolation ([#483](https://github.com/mimsy/volute/issues/483)) ([5e8e541](https://github.com/mimsy/volute/commit/5e8e541aa9d42b2f73d65e248efb64ddd3e8bb30))
* clean up ephemeral session state and per-message listeners ([#487](https://github.com/mimsy/volute/issues/487)) ([8e14735](https://github.com/mimsy/volute/commit/8e147354f04119a4858e7710701cb40b23c0196a))
* deliver mind-to-spirit DMs exactly once ([#478](https://github.com/mimsy/volute/issues/478)) ([787f354](https://github.com/mimsy/volute/commit/787f35409b6666f7809812bb1eb7ec9a5edda8af))
* exclude local restic repo from backup and fix oauth-health boundary flake ([#482](https://github.com/mimsy/volute/issues/482)) ([2203db1](https://github.com/mimsy/volute/commit/2203db1f9c13e508bea7a954848c353ad8b755e1))
* failed variant join leaves parent files root-owned under isolation ([#496](https://github.com/mimsy/volute/issues/496)) ([883699f](https://github.com/mimsy/volute/commit/883699f6080760f82e4ae7a202eb94198965c592))
* harden variant join — abort failed merges, stop variant server, use registry dirs ([#475](https://github.com/mimsy/volute/issues/475)) ([f99e6ff](https://github.com/mimsy/volute/commit/f99e6ffe3a482b8cdcb7bb559cfe7cf353ac67c6))
* imagegen skill distinguishes daemon errors from missing config ([#479](https://github.com/mimsy/volute/issues/479)) ([6649adc](https://github.com/mimsy/volute/commit/6649adc5ef309f309158c9904eac59898077f8f3))
* reap idle sessions to release SDK subprocess memory ([#492](https://github.com/mimsy/volute/issues/492)) ([01fd8af](https://github.com/mimsy/volute/commit/01fd8afd8a5ccb7a5f3cdbea161b82c4eef0770c))
* recover pages repo from interrupted git init ([#488](https://github.com/mimsy/volute/issues/488)) ([ffd9214](https://github.com/mimsy/volute/commit/ffd9214813ed2a6ab9641a2c32eac9b903ce6da5))
* route memory consolidation through ai-service and bound input ([#471](https://github.com/mimsy/volute/issues/471)) ([320b65c](https://github.com/mimsy/volute/commit/320b65c93f3535d28b4c4304e4de973cdddf8100))
* run schedule scripts with the mind's auth env ([#474](https://github.com/mimsy/volute/issues/474)) ([c8d7a33](https://github.com/mimsy/volute/commit/c8d7a33b2ff6386c5904f8a0faf86934326a7251))
* **scheduler:** default schedule fires to queue while sleeping ([#481](https://github.com/mimsy/volute/issues/481)) ([fc015cf](https://github.com/mimsy/volute/commit/fc015cf169781e9028ab226c19f2b84fd76c3b1c))
* sleep-queue flush double-records messages and mishandles failures ([#476](https://github.com/mimsy/volute/issues/476)) ([70e69f6](https://github.com/mimsy/volute/commit/70e69f6f1a4d750f8592627309a2baa317acdb2f))
* spirit never replies to its own messages ([#484](https://github.com/mimsy/volute/issues/484)) ([7db6bb7](https://github.com/mimsy/volute/commit/7db6bb7c27a98f59a408a1a86ff49001ddda3b21))
* **web:** wake-trigger checkboxes reflect runtime defaults ([#473](https://github.com/mimsy/volute/issues/473))j ([2c5cb29](https://github.com/mimsy/volute/commit/2c5cb2954f67bdfa5685821ada43ad7d76ebe781))

## [0.45.1](https://github.com/mimsy/volute/compare/volute-v0.45.0...volute-v0.45.1) (2026-07-07)


### Bug Fixes

* skip restic round-trip cleanly when restic is not installed ([#469](https://github.com/mimsy/volute/issues/469)) ([718561b](https://github.com/mimsy/volute/commit/718561bdb14070b2d2122a522fe7e6b3740dff22))

## [0.45.0](https://github.com/mimsy/volute/compare/volute-v0.44.0...volute-v0.45.0) (2026-07-07)


### Features

* restic-based system backups ([#457](https://github.com/mimsy/volute/issues/457)) ([802ef5f](https://github.com/mimsy/volute/commit/802ef5fb60c1b688c043c15bfd2c6c01548a7d5a))


### Bug Fixes

* accept home-relative avatar paths in mind profile updates ([#390](https://github.com/mimsy/volute/issues/390)) ([c94d416](https://github.com/mimsy/volute/commit/c94d416c7844ec1791589733f7aa694b673bf3e6))
* align mind-facing docs and messages with actual behavior, warm system messages ([#439](https://github.com/mimsy/volute/issues/439)) ([483cee1](https://github.com/mimsy/volute/commit/483cee1cb928f654f5de8f5d0b9d2f9effee6ef5))
* attach menu in web chat instantly self-closing ([#411](https://github.com/mimsy/volute/issues/411)) ([92c9b65](https://github.com/mimsy/volute/commit/92c9b65887f0c3c49de77fc3fb45e7047e671571))
* enable skill discovery in claude template ([#391](https://github.com/mimsy/volute/issues/391)) ([8c4becc](https://github.com/mimsy/volute/commit/8c4becc5f5a87cd65b4e779f8b5dd3ba30e52eaa))
* make unread message dots reliable ([#410](https://github.com/mimsy/volute/issues/410)) ([0855d7c](https://github.com/mimsy/volute/commit/0855d7cd529b2838d5936596ab5f4baa293a27d3))
* record tool-call errors in mind history and link results by tool id ([#388](https://github.com/mimsy/volute/issues/388)) ([a95a32b](https://github.com/mimsy/volute/commit/a95a32b56f2c0e126d6dc90f65ef73f008108ec8))

## [0.44.0](https://github.com/mimsy/volute/compare/volute-v0.43.1...volute-v0.44.0) (2026-07-04)


### Features

* extension discovery, extension notices, and notes overhaul ([#385](https://github.com/mimsy/volute/issues/385)) ([a590d1c](https://github.com/mimsy/volute/commit/a590d1ceef668a372e0af271c7036ccf147b2cd2))


### Bug Fixes

* hold stale multi-mind sends instead of aborting turns mid-tool ([#387](https://github.com/mimsy/volute/issues/387)) ([28cc5ed](https://github.com/mimsy/volute/commit/28cc5ed86281e10767fa6627fcf04d4981e46107))
* optimize web image serving (avatar resize, caching, lightbox) ([#375](https://github.com/mimsy/volute/issues/375)) ([9785fcf](https://github.com/mimsy/volute/commit/9785fcfd28df5f797781236a6a700f4bc6504799))
* pages UI empty-mind dashboard fallthrough and publish resetting all page dates ([#377](https://github.com/mimsy/volute/issues/377)) ([b91c685](https://github.com/mimsy/volute/commit/b91c6853a38ab2e2c134bba554c71c22ba9c2baf))
* remove mind→mind conversation turn cap ([#386](https://github.com/mimsy/volute/issues/386)) ([48cf010](https://github.com/mimsy/volute/commit/48cf01053e66630885911e6a4a528ad76391dcc6))
* repair daemon e2e tests and run them in CI ([#378](https://github.com/mimsy/volute/issues/378)) ([e3c9efe](https://github.com/mimsy/volute/commit/e3c9efe90c16f769ef234feb4fb13f2df3248e2f))

## [0.43.1](https://github.com/mimsy/volute/compare/volute-v0.43.0...volute-v0.43.1) (2026-07-03)


### Bug Fixes

* chown parent pages dir to mind user under isolation ([#361](https://github.com/mimsy/volute/issues/361)) ([cdb6acf](https://github.com/mimsy/volute/commit/cdb6acfb9bb2e7c50a3cdd12e7ad0815d6591d0f))
* recover in-flight messages dropped by compaction abort ([#362](https://github.com/mimsy/volute/issues/362)) ([3ac5732](https://github.com/mimsy/volute/commit/3ac5732b24864b6c4545c9bd654204539cb545d0))

## [0.43.0](https://github.com/mimsy/volute/compare/volute-v0.42.1...volute-v0.43.0) (2026-07-02)


### Features

* last-known-good restart protection for self-modifying minds ([#352](https://github.com/mimsy/volute/issues/352)) ([04da3a0](https://github.com/mimsy/volute/commit/04da3a0cc5aebf5f81c2d8fe5083dcae37b46942))
* provider-qualified AI model identity ([#358](https://github.com/mimsy/volute/issues/358)) ([d6b437d](https://github.com/mimsy/volute/commit/d6b437dfa03b5369942739fa9ccc80d37f1ac0b7))


### Bug Fixes

* gate /api/v1/events activity feed to the calling mind ([#346](https://github.com/mimsy/volute/issues/346)) ([c7ec82f](https://github.com/mimsy/volute/commit/c7ec82f2b3e9551f5957bcaf8b78a9b71c1604ac))
* make delivery_queue the source of truth for message delivery ([#351](https://github.com/mimsy/volute/issues/351)) ([1832582](https://github.com/mimsy/volute/commit/1832582349d0064244de57e82be445041d352e5d))
* restore recordNotice import and drop dead classify import in minds.ts ([#360](https://github.com/mimsy/volute/issues/360)) ([0e791de](https://github.com/mimsy/volute/commit/0e791def5475d2657a05ef3116066fa6801d428e))
* serialize MindManager lifecycle and make chown async ([#349](https://github.com/mimsy/volute/issues/349)) ([b830313](https://github.com/mimsy/volute/commit/b83031388705e32c02e8645eebc9d61a7a17be9d))

## [0.42.1](https://github.com/mimsy/volute/compare/volute-v0.42.0...volute-v0.42.1) (2026-07-02)


### Bug Fixes

* split daemon.json admin token into a 0600 file so the operator CLI can read it ([#354](https://github.com/mimsy/volute/issues/354)) ([060f82e](https://github.com/mimsy/volute/commit/060f82e2a7558d9759b4c2ac915cb57c26c3ca04))

## [0.42.0](https://github.com/mimsy/volute/compare/volute-v0.41.1...volute-v0.42.0) (2026-07-02)


### Features

* allow adding custom (freeform) AI models ([#345](https://github.com/mimsy/volute/issues/345)) ([4e39057](https://github.com/mimsy/volute/commit/4e390577aa34ae0716ee2a3055ded0cab7b69c30))


### Bug Fixes

* restore operator CLI access broken by config.json 0600 lockdown ([#350](https://github.com/mimsy/volute/issues/350)) ([74e03bd](https://github.com/mimsy/volute/commit/74e03bd3ac72a2d402c9a80be784e5e84bea270d))
* strip provider prefix from codex mind model ([#348](https://github.com/mimsy/volute/issues/348)) ([3e6c40b](https://github.com/mimsy/volute/commit/3e6c40ba2ae37773512792278987ea0f173ed3fc))

## [0.41.1](https://github.com/mimsy/volute/compare/volute-v0.41.0...volute-v0.41.1) (2026-07-02)


### Bug Fixes

* cross-tenant data exposure via history API and SSE replay buffer ([#341](https://github.com/mimsy/volute/issues/341)) ([c2ad729](https://github.com/mimsy/volute/commit/c2ad729c5c11da345f158ec2f4d49317153b601c))
* extension command endpoint trusts body.mind over authenticated identity ([#339](https://github.com/mimsy/volute/issues/339)) ([78583b1](https://github.com/mimsy/volute/commit/78583b18ed6bf0950ece20332fe585289f87c761))
* install deps when spirit switches templates ([#344](https://github.com/mimsy/volute/issues/344)) ([1f32b5b](https://github.com/mimsy/volute/commit/1f32b5b651cce1d1d6ae4a799f7eb4201fdd75d7))
* prevent CLI timeout on long-running daemon operations ([#318](https://github.com/mimsy/volute/issues/318)) ([1d2f131](https://github.com/mimsy/volute/commit/1d2f13135a13d077a7a7b4a6a1f47a56b2db4596))
* sandbox and privileged script execution fail open ([#338](https://github.com/mimsy/volute/issues/338)) ([ba545d8](https://github.com/mimsy/volute/commit/ba545d817b79cbc4d4886442bf5719e0376664a7))
* secret file permissions, mind token env naming, and env inheritance ([#340](https://github.com/mimsy/volute/issues/340)) ([7a5e3c8](https://github.com/mimsy/volute/commit/7a5e3c8e881dc4d537e5b7c363e7fb083e845493))
* skill publishing lets a mind overwrite shared/built-in skills ([#337](https://github.com/mimsy/volute/issues/337)) ([27ed6ed](https://github.com/mimsy/volute/commit/27ed6ed764ce03aaad9d63fce082fd339b661a7d))

## [0.41.0](https://github.com/mimsy/volute/compare/volute-v0.40.2...volute-v0.41.0) (2026-07-01)


### Features

* support switching a mind's template on upgrade ([#315](https://github.com/mimsy/volute/issues/315)) ([f01bfe9](https://github.com/mimsy/volute/commit/f01bfe9a8e7895e50000ada56d451674b090169b))


### Bug Fixes

* keep pages extension loadable in bundled builds ([#317](https://github.com/mimsy/volute/issues/317)) ([251a05e](https://github.com/mimsy/volute/commit/251a05e1a20983738ce5c11bd7ea7c74f4343478))

## [0.40.2](https://github.com/mimsy/volute/compare/volute-v0.40.1...volute-v0.40.2) (2026-07-01)


### Bug Fixes

* reconcile turns wedged active by a leaked delivery counter ([#311](https://github.com/mimsy/volute/issues/311)) ([d4899f3](https://github.com/mimsy/volute/commit/d4899f341bdaf113bbc91ad346b6c71852649e70))
* track mind "active" as an open turn, not stream setup ([#313](https://github.com/mimsy/volute/issues/313)) ([5f26234](https://github.com/mimsy/volute/commit/5f2623465f2a49cf44c30bf58b6e59c3b67097f4))

## [0.40.1](https://github.com/mimsy/volute/compare/volute-v0.40.0...volute-v0.40.1) (2026-06-23)


### Bug Fixes

* enforce per-route authorization and harden web API against cross-mind access ([#308](https://github.com/mimsy/volute/issues/308)) ([617dfa1](https://github.com/mimsy/volute/commit/617dfa1417299ecc5f23be491648a5ce8543ef09))
* make volute update target the running binary's prefix and verify ([#310](https://github.com/mimsy/volute/issues/310)) ([4a19ab3](https://github.com/mimsy/volute/commit/4a19ab3eccccc95658516e90540a81e389be4d15))

## [0.40.0](https://github.com/mimsy/volute/compare/volute-v0.39.0...volute-v0.40.0) (2026-06-22)


### Features

* notify minds of prior failures on their next successful turn ([#306](https://github.com/mimsy/volute/issues/306)) ([d609075](https://github.com/mimsy/volute/commit/d609075de81820d8a24eecac1a519c16f640c86a))


### Bug Fixes

* centralize Anthropic OAuth refresh to stop recurring 401s ([#305](https://github.com/mimsy/volute/issues/305)) ([9600ee5](https://github.com/mimsy/volute/commit/9600ee566c94644c4997a07ca8e66e1496ab27f3))
* pi template API key fallback, sandbox network fix, and pre-warm sessions ([#302](https://github.com/mimsy/volute/issues/302)) ([0de507b](https://github.com/mimsy/volute/commit/0de507b158f7590448bf958a45e31cdeae58a7bc))

## [0.39.0](https://github.com/mimsy/volute/compare/volute-v0.38.0...volute-v0.39.0) (2026-04-02)


### Features

* replace typing indicator with activity indicator in chat ([#297](https://github.com/mimsy/volute/issues/297)) ([068e8f6](https://github.com/mimsy/volute/commit/068e8f646798c6fe91e37f28d4d8f78516a08047))
* show spirit in sidebar with own mind page ([#301](https://github.com/mimsy/volute/issues/301)) ([56b00cd](https://github.com/mimsy/volute/commit/56b00cd51e9de52c7b7d7452953cdd6a324b3fa4))


### Bug Fixes

* sandbox improvements and codex macOS crash fix ([#300](https://github.com/mimsy/volute/issues/300)) ([7324f6e](https://github.com/mimsy/volute/commit/7324f6ec6f7fc6229c83017402a2c9728ce89116))
* setup provider crash and sandbox read isolation ([#298](https://github.com/mimsy/volute/issues/298)) ([09baee0](https://github.com/mimsy/volute/commit/09baee0f909e0e7ab52150f3e67f0add5ad76ab1))

## [0.38.0](https://github.com/mimsy/volute/compare/volute-v0.37.1...volute-v0.38.0) (2026-04-01)


### Features

* default volute setup to web-based flow with advanced options ([#295](https://github.com/mimsy/volute/issues/295)) ([596ab17](https://github.com/mimsy/volute/commit/596ab173314e042e7885b5418a717ee57122c72a))
* fix model escape errors in mind outbound messages ([#296](https://github.com/mimsy/volute/issues/296)) ([c293ffe](https://github.com/mimsy/volute/commit/c293ffe3f624f3c0a7f79786aa314ffc2018f461))


### Bug Fixes

* parse messages API response correctly in setup spirit reply polling ([5f59dfe](https://github.com/mimsy/volute/commit/5f59dfee2fbf7a082b616ba76e75a65ebe1b8240))
* resolve stale OAuth code promise to unblock callback server cleanup ([ad6be47](https://github.com/mimsy/volute/commit/ad6be47f584068e15407d69fdc67e8950a28a016))

## [0.37.1](https://github.com/mimsy/volute/compare/volute-v0.37.0...volute-v0.37.1) (2026-04-01)


### Bug Fixes

* write codex CLI auth.json for OAuth instead of setting OPENAI_API_KEY ([14529f1](https://github.com/mimsy/volute/commit/14529f161f452996cbe1b23a65ad8c34dabdcc5a))

## [0.37.0](https://github.com/mimsy/volute/compare/volute-v0.36.0...volute-v0.37.0) (2026-04-01)


### Features

* add echoText option to send mind text outputs to triggering channel ([#287](https://github.com/mimsy/volute/issues/287)) ([8abba03](https://github.com/mimsy/volute/commit/8abba0373a325fe45c17bfbaaa41caaf2465d094))


### Bug Fixes

* setup flow, OAuth UX, and spirit startup issues ([#289](https://github.com/mimsy/volute/issues/289)) ([1a7d072](https://github.com/mimsy/volute/commit/1a7d07255fb7766088bb8a57d13f8ec7bd1ab352))

## [0.36.0](https://github.com/mimsy/volute/compare/volute-v0.35.0...volute-v0.36.0) (2026-03-26)


### Features

* add spirit tending system to encourage minds to use extensions ([#282](https://github.com/mimsy/volute/issues/282)) ([2cdf417](https://github.com/mimsy/volute/commit/2cdf417ae6ba678bfad61cc6a655fb9bdac32dde))


### Bug Fixes

* clean up leftover conversation columns after migration 0007 ([#283](https://github.com/mimsy/volute/issues/283)) ([6cb64b1](https://github.com/mimsy/volute/commit/6cb64b14d4b54a679128bfb666aaa36804807641))
* use volute system dir for npm cache in spirit creation ([#279](https://github.com/mimsy/volute/issues/279)) ([f1600fe](https://github.com/mimsy/volute/commit/f1600fe91afadf9ef57b9593cdaa3fd856a4c018))


### Performance Improvements

* optimize database queries, add indexes, cache hot paths, async I/O ([#286](https://github.com/mimsy/volute/issues/286)) ([7cff6cf](https://github.com/mimsy/volute/commit/7cff6cff94d1a6cb640e56bba63c9e557909d695))

## [0.35.0](https://github.com/mimsy/volute/compare/volute-v0.34.0...volute-v0.35.0) (2026-03-26)


### Features

* add --help support across all CLI commands ([#272](https://github.com/mimsy/volute/issues/272)) ([43e1948](https://github.com/mimsy/volute/commit/43e19480b952d2303131e544958c3ee0d7a3d19e))
* add markdown page rendering to pages extension ([#269](https://github.com/mimsy/volute/issues/269)) ([ee9af1a](https://github.com/mimsy/volute/commit/ee9af1a760e777b1021445d0f9a66b0461af42d1))
* add structured args/flags to extension commands with auto-generated --help ([#276](https://github.com/mimsy/volute/issues/276)) ([3c433c2](https://github.com/mimsy/volute/commit/3c433c278fbc9155268a301a051398919911f08a))
* enable remote web UI connections to daemon ([#274](https://github.com/mimsy/volute/issues/274)) ([d25e4c2](https://github.com/mimsy/volute/commit/d25e4c2cdf2450e1c397e426c55b675c0e468f5a))
* OAuth error detection, re-auth UI, and session resilience ([#275](https://github.com/mimsy/volute/issues/275)) ([4e126da](https://github.com/mimsy/volute/commit/4e126dabb7c273607583e327162475c6e8bca915))


### Bug Fixes

* ensure npm cache dir exists for spirit creation ([#277](https://github.com/mimsy/volute/issues/277)) ([be3ccda](https://github.com/mimsy/volute/commit/be3ccda9db51fbc39e2a60736eb0884e36a5419f))
* system pages separation, error handling, and test coverage ([#270](https://github.com/mimsy/volute/issues/270)) ([ed5f9fc](https://github.com/mimsy/volute/commit/ed5f9fcc10e0d3e73623e0cb87d812e0ab14a48a))

## [0.34.0](https://github.com/mimsy/volute/compare/volute-v0.33.0...volute-v0.34.0) (2026-03-25)


### Features

* add default mind settings UI ([#263](https://github.com/mimsy/volute/issues/263)) ([f0f9854](https://github.com/mimsy/volute/commit/f0f98549cb8fa360d3aa6ee66001b36b7cbd9d54))
* add extension management UI in system settings ([#260](https://github.com/mimsy/volute/issues/260)) ([1255278](https://github.com/mimsy/volute/commit/1255278cb7f151c091fdcc91f4d43646883274cf))
* add progressive meta-summarization system ([#264](https://github.com/mimsy/volute/issues/264)) ([6cccf9d](https://github.com/mimsy/volute/commit/6cccf9deb3fa082903ae71e4ed28918d587f023a))
* add session context inspector with waffle chart ([#266](https://github.com/mimsy/volute/issues/266)) ([dff5c9c](https://github.com/mimsy/volute/commit/dff5c9cc6eb545d458e9b6f302cf092c755ff435))
* add spirit settings UI ([#262](https://github.com/mimsy/volute/issues/262)) ([35996c9](https://github.com/mimsy/volute/commit/35996c9bd495defbcb891d4d8f1983923634e9c1))
* add system plan extension for coordinated mind activity ([#257](https://github.com/mimsy/volute/issues/257)) ([d51d63b](https://github.com/mimsy/volute/commit/d51d63bcdd1aa0aa644b0ac5aa10d5291343a73d))
* add template type safety with composed typechecking ([#261](https://github.com/mimsy/volute/issues/261)) ([4b837d0](https://github.com/mimsy/volute/commit/4b837d07e0192a1564890db5e82c736fdc147004))
* auto-update mind skills on daemon startup ([#265](https://github.com/mimsy/volute/issues/265)) ([5dc39c9](https://github.com/mimsy/volute/commit/5dc39c9d09f2ac8033601f3ba819100fd2dc474e))
* redesign mind settings, sidebar, and schedule UI ([#250](https://github.com/mimsy/volute/issues/250)) ([44aa646](https://github.com/mimsy/volute/commit/44aa646b1d04470e928d6a7aad743a4902cfc213))
* reduce mind token usage across prompts, messages, skills, and CLI ([#252](https://github.com/mimsy/volute/issues/252)) ([1c0747c](https://github.com/mimsy/volute/commit/1c0747c710fef7899de7d8b2f0c41c20afccda2d))
* smooth UI improvements ([#258](https://github.com/mimsy/volute/issues/258)) ([169df65](https://github.com/mimsy/volute/commit/169df65e313128d30b30e9b7008890a70fa661c2))


### Bug Fixes

* eliminate ghost turns from startup context routing ([#259](https://github.com/mimsy/volute/issues/259)) ([987c2d9](https://github.com/mimsy/volute/commit/987c2d9bcefbad7faf9288f821c5cb07798af9b1))

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
