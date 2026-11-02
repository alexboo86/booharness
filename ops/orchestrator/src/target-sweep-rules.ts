// Shared policy data; remote scripts interpolate these without importing seat code.
export const BUILDERS = /^(?:cargo|cargo-.+|rustc|rust-analyzer|tauri)(?:\.exe)?$/i;
export const CARGO_MARKERS = ['CACHEDIR.TAG', '.rustc_info.json'] as const;
export const RECENT_BUILD_RULE = { profiles: ['debug', 'release'], depth: 2 } as const;
export const FLOCK = '/usr/bin/flock', PERL = '/usr/bin/perl';
