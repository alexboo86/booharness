# ffmpeg-skill

Upstream: https://github.com/kajisho5/ffmpeg-skill
Source: repository root at commit `1ae1bdf1ca0adbb1606fbca493948b1bbb2f83ff`.
Vendored 2026-10-29 by operator decisions #21078, #21079 and #21082
(task 3336 S3); fetched from the SHA-specific GitHub codeload archive.
License: MIT (upstream LICENSE retained).

Only SKILL.md, scripts/, templates/, references/ and LICENSE are copied,
byte-for-byte except for the local modification below. This PROVENANCE.md is local metadata, not upstream content.
Excluded: .claude-plugin, .github and CI files, bin/ installer, package.json,
assets/, brand/, demos/, docs/, tests and other root documents/tooling.
No skill installation into homes, plugin activation or automatic updates.

## Local modifications

- 2026-10-29: scripts/check.py's docstring calls the row's fix field plain text
  rather than a backticked name, avoiding a collision with an excluded skill in
  the portable kit leak gate. Runtime behaviour is unchanged.

## Execution and network review

The shipped scripts are 58 Python files (42 editing/measurement entry points
and 16 support files), using local FFmpeg/ffprobe and Python's standard library.
No direct HTTP client, socket connection or shell-pipe installer was found.
Subprocesses invoke local tools; input media and referenced playlists must be
staged and inspected because FFmpeg itself supports network protocols.

Speech recognition is a separate network risk: scripts/_common/asr.py documents
first-use model downloads for parakeet-mlx (Hugging Face), faster-whisper and
openai-whisper; whisper.cpp requires a separately supplied local model.
The local workflow forbids first-use downloads at render time. Supply approved
local models beforehand, or use supplied timed text instead of transcription.
No media upload is approved. ASR engine, font and FFmpeg installation hints in
the upstream text are informational, not permission to install software.

Use only the vendored Python scripts. The upstream unpinned npm doctor/update
suggestions and Python package installation hints are deliberately retained unchanged and
recorded in scripts/unpinned-installs.json per the operator's vendoring brief;
they are not approved execution routes. No upstream CLI, MCP or npm installer
is included. Project policy and motion-media override upstream output defaults,
optional downloads and capability-dependent visual-inspection shortcuts.

Homebrew ffmpeg-full is the approved local GPL, keg-only build. Prefix PATH
with /opt/homebrew/opt/ffmpeg-full/bin for these scripts; text and subtitles
must use that build. All working artifacts, including temporary files, belong
under web/apps/landing/_drafts/motion/; approved delivery assets belong under
web/apps/landing/public/media/. No render-time network fetching is allowed.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
scripts/_ass_overlay.py sha256:01d98d2a07d28f78ec695479173fae2e4ee9382a1739a3a3c2e4f83bba29432e
scripts/_common/__init__.py sha256:97df629103cd3a8dedb7e90ff908ed7d702b48d11d7d4d82ffd1044fef0cbcd5
scripts/_common/asr.py sha256:2715b731b5f50406ae71a76d24b88bd27c00ef5bba0d9b886e416e85d80829ed
scripts/_common/color.py sha256:bcd80511336f0f2687dab494a682e6f58f1683c511fe354789b2dc81fb42d34d
scripts/_common/decision.py sha256:814b6eaa6a41e892d0b84ea56347504262dadd05c7ab5d0af57d27c172eb2d32
scripts/_common/drawtext.py sha256:b02628bbd2413af36b6abadb977930ef024380217e2967ceda4c09fd39b404ca
scripts/_common/emit.py sha256:a566234cce5f41ccbde0d8c3c03d05bb944e396269780103dd4e0e9b240e1ebb
scripts/_common/emoji.py sha256:6708dd48e49a37f1c0d9c5374e696c2291221c88833415e179f8cd2b29055999
scripts/_common/fonts.py sha256:db276f013c32ab9c73e92ecde02a51de3a1a5974557186eaa4b5b821260e66f6
scripts/_common/probe.py sha256:79343a86b4b750a02d1ead57e52fd01226cb6ac8f42f5e1de8c8a900a0f533cb
scripts/_common/runner.py sha256:b70ac2125724fd697d07ddb91ab03b6d5047cee231caebe2c8c3f605e5177ced
scripts/_common/text.py sha256:bb05514c53e736d8d16abad37ab7da4fcf13f19785d0c28205f16c1e394f0496
scripts/_common/timeline.py sha256:3525562b3b06dc04aba9e206fd555fe64b66f375c353d2d9a4737ebf1f7955b8
scripts/_common/wrap.py sha256:49259773eee98c6276c455ead8e5db10da48bd39e29cb687601010a084132aff
scripts/_contract.py sha256:c5ac86579861cb1b5ad54c243998e38f2ed73750c7dc981d9c59432f153d1dd7
scripts/_platforms.py sha256:3b06a2c1cda1f106e9ae7699e9e6b4b0d490352655f8eebeb9336b4f4b524ae8
scripts/audio.py sha256:2c2b512a4b8ee48e68beb4ce6abeb9a25770c5f6f4298921c54da6de7edcae92
scripts/background.py sha256:0f314601e8617454c63d5183dab50edcaefc79303aeff15d15c487c19df766c8
scripts/batch.py sha256:a940d3e40c3ce39ec15b3734b692b0fe33374ec257b357ca032f62e4fcb2244d
scripts/broll.py sha256:86262e72cdba415371e9fbee8198ef986a8e50d0a168246e5f0541309b2ea33f
scripts/caption.py sha256:089ac39acd01cb56921479868e2a69766ab584053402a7c13e6b199c74b54276
scripts/check.py sha256:3c8d8ed3dc6016287d1b3dbe689917e5697b1a7855dc5494cc4b6bfc9c959c94
scripts/color.py sha256:eb4d70414df756c982bd7a2cc27bcd9aa35fa7b912d2d3e24ebd023b50c87b39
scripts/crop.py sha256:b209f617da1af72b0fa213c2bafe361838a48826cb963f12c23609a52f4ea55e
scripts/cropdetect.py sha256:ec04ab5564ee508f42466388eb7b1932e757cc29477bb6dd4498c43580c9b7e4
scripts/cut.py sha256:3bf06863c86329d1c2e6a8aee9e68162ef214c485a8355a3d20323b8cd9d74e4
scripts/deinterlace.py sha256:e7f49973222570ef285abc37c3e485492714e5efc47e6b4672fd3fe20e2b0cff
scripts/denoise.py sha256:ca27a98d9a18ad4b6b1ad823e0f944c329d8095c09d866839eff48f9833b904e
scripts/export.py sha256:b9b8a9c77b9e8a4ba6d865d98ecfdbe83cbc3987e69ba977a8f8cddfefc19b66
scripts/fit.py sha256:097ff44fd42e1bc1ecb007589a8eff18853cfc5f2f0319a43245965785d16649
scripts/freeze.py sha256:be3613f5a952c5d0a4b4512c482818e875cc0e130f66841ba864ad37d619dea7
scripts/graphics.py sha256:488191d59b71bc6936199366eab0ccaf3723587be3637cf47e64a9016ae2d3d0
scripts/grid.py sha256:8ff01075028a2d244caa976d62bce30edaa707d1a8aa0b8535f9eda5638278bd
scripts/insert.py sha256:b2124a5e96c59079ac5d4b7368428d8c7d079c421fada652491cb6efec79fe49
scripts/join.py sha256:52b5f22df480f25c7550fe1b7d1321b9e68a6778d4ca830253b50fb851589b7b
scripts/look.py sha256:bca2ef742e337f2bf9bdbae9c75d2260f004f4f1a4b8480968f161e570ba2373
scripts/loop.py sha256:42ffd1d80fa3f063a98358ffd82f0544c37c3a7bbcf6d70cde4b92cc2e610f29
scripts/loudness.py sha256:f669f8b7c38c2e106fb93706191ab6b02f3efc1ec1fe20064f11f901821e3930
scripts/metadata.py sha256:36e6e5fd200e771d8b550e98e6be926b3b6b4eb75d1418f5e8905ffa212c4eeb
scripts/multicam.py sha256:40ad292a50d4f560777ac800f88e5e4d1965bd8f67eb3ac7b6ec9ee41d35779c
scripts/overlay.py sha256:37667616df483e8e0efb60d4a5b6f6f5a7f76f1ff0be3ffc1b35869a5506b3b1
scripts/pad.py sha256:6a5970e26e66af8befe3f2913c8f66c92289b470e12ae17ef2b29df537fe2b37
scripts/probe.py sha256:e2fd1390bc9976d5086e06e0a9ea64bd966638273339709ee7c2a0fa53210063
scripts/proxy.py sha256:1323a89caf31d68c27008b51fc636895e465b14ba6b69ea2442273257a15303e
scripts/redact.py sha256:cf09b6dc33d572aa041ed876256851fb92d78f32e030404fbde4577007cc715b
scripts/render.py sha256:b17cd3f57f72742816e141bcd73a49cf94de0fa4f519000aa2d1de0ce74135e0
scripts/report.py sha256:8a94b39f177d364e88d346c81d81f112f9a96ed18929f045417e3047f33bc4e2
scripts/reverse.py sha256:8bba3e8df23dabd1797a6737bfcfa8566a9ad88ab59fcb310631d89893e3beb3
scripts/scenes.py sha256:44d1ec1e79fa715ddd707664848ab6d0ddba15d2738df17d61e3e38cebec833a
scripts/sequence.py sha256:05c0f920ca2318572ba569bd49a5d52cfb8c98e617b5bf3ed0cc4bca64424cbc
scripts/silence.py sha256:2f1f93053fa363519222179aaf2efed37d9ae53f77bf73b5c1ca1f54e52aa79e
scripts/speedramp.py sha256:374a3136918b2aefae4ec00400f96b3d480f4d9732f1e12f2d936ebb24d05213
scripts/sphere.py sha256:a69aa312e978ee8677b51e178164635f78c36f9c3bf1ee6078dca33d7b31f862
scripts/stabilize.py sha256:4971a6dc90d2dab35fd19662529450c8f2a32d1bd9c3aa4d7df6f4a1443887e5
scripts/straighten.py sha256:395a7084eefc141a3a65c2d40d367e8cd5c408de1bace5422139deafb7a89c27
scripts/sync.py sha256:fd507ad0a031700ac9c2cd7f529e43e9365c21b3d97bff0c272b05fbf97dce7f
scripts/verify.py sha256:79a5ee0f1a6f659d953403179ef82e9b4bb067d3f9d7e1db2a000b446ce2b3fd
scripts/waveform.py sha256:afeb802e62e11616bef89ddd7104bbd42d743da78c71274a12c80448548cefbe
```
