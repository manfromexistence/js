pub(crate) const CHAR_FREQ_COUNT: usize = 64;

#[derive(Copy, Clone, Default)]
pub(crate) struct CharAndCount {
    pub char: u8,
    pub count: i32,
    pub index: usize,
}

// PORT NOTE: Zig `CharAndCount.Array` was an associated type alias; inherent
// associated types are unstable in Rust, so it's a free alias here.
pub(crate) type CharAndCountArray = [CharAndCount; CHAR_FREQ_COUNT];

type Buffer = [i32; CHAR_FREQ_COUNT];

#[derive(Copy, Clone)]
pub struct CharFreq {
    // PORT NOTE: Zig field was `align(1)` (unaligned i32 array). Rust gives natural
    // alignment; if the packed layout was load-bearing for an FFI/serialized struct,
    // revisit.
    pub freqs: Buffer,
}

impl Default for CharFreq {
    #[inline]
    fn default() -> Self {
        Self {
            freqs: [0i32; CHAR_FREQ_COUNT],
        }
    }
}

const SCAN_BIG_CHUNK_SIZE: usize = 32;
#[cfg(not(test))]
const DISABLE_SIMD_CHAR_FREQUENCY_ENV: &str = "BUN_DX_DISABLE_SIMD_CHAR_FREQUENCY";

impl CharFreq {
    pub fn scan(&mut self, text: &[u8], delta: i32) {
        if delta == 0 {
            return;
        }

        if text.len() < SCAN_BIG_CHUNK_SIZE {
            scan_small(&mut self.freqs, text, delta);
        } else {
            scan_big(&mut self.freqs, text, delta);
        }
    }

    pub fn include(&mut self, other: &CharFreq) {
        // https://zig.godbolt.org/z/Mq8eK6K9s
        // PERF(port): Zig used @Vector SIMD add — profile
        for (l, r) in self.freqs.iter_mut().zip(other.freqs.iter()) {
            *l += *r;
        }
    }

    pub fn compile(&self) -> crate::NameMinifier {
        use crate::NameMinifier;
        let array: CharAndCountArray = 'brk: {
            let mut arr: [CharAndCount; CHAR_FREQ_COUNT] =
                [CharAndCount::default(); CHAR_FREQ_COUNT];

            debug_assert_eq!(NameMinifier::DEFAULT_TAIL.len(), CHAR_FREQ_COUNT);
            for (i, ((dest, &char), &freq)) in arr
                .iter_mut()
                .zip(NameMinifier::DEFAULT_TAIL.iter())
                .zip(self.freqs.iter())
                .enumerate()
            {
                *dest = CharAndCount {
                    char,
                    index: i,
                    count: freq,
                };
            }

            // std.sort.pdq → Rust's sort_unstable_by (pattern-defeating quicksort).
            // PORT NOTE: do NOT route through `CharAndCount::less_than` and map
            // false→Greater — that comparator never returns `Equal`, which
            // violates `sort_unstable_by`'s total-order contract (Rust 1.81+
            // is permitted to panic on inconsistent comparators). `index` is
            // unique so equality is unreachable in practice, but keep the
            // comparator well-formed regardless.
            arr.sort_unstable_by(|a, b| {
                // descending by count, then ascending by (index, char) —
                // matches CharFreq.zig:12 `CharAndCount.lessThan`.
                b.count
                    .cmp(&a.count)
                    .then_with(|| a.index.cmp(&b.index))
                    .then_with(|| a.char.cmp(&b.char))
            });

            break 'brk arr;
        };

        let mut minifier = NameMinifier::init();
        minifier.head.reserve_exact(
            NameMinifier::DEFAULT_HEAD
                .len()
                .saturating_sub(minifier.head.len()),
        );
        minifier.tail.reserve_exact(
            NameMinifier::DEFAULT_TAIL
                .len()
                .saturating_sub(minifier.tail.len()),
        );
        // TODO: investigate counting number of < 0 and > 0 and pre-allocating
        for item in array {
            if item.char < b'0' || item.char > b'9' {
                minifier.head.push(item.char);
                // PERF(port): was `catch unreachable` (assume_capacity)
            }
            minifier.tail.push(item.char);
            // PERF(port): was `catch unreachable` (assume_capacity)
        }

        minifier
    }
}

fn scan_big(out: &mut Buffer, text: &[u8], delta: i32) {
    debug_assert!(text.len() >= SCAN_BIG_CHUNK_SIZE);

    // `cargo test -p bun_ast` does not link the C++ Highway object directly.
    // Keep unit tests on the scalar reference path while production builds use
    // the same Highway helper already shared by the lexer/string fast paths.
    #[cfg(test)]
    {
        scan_big_portable(out, text, delta);
    }

    #[cfg(not(test))]
    {
        if simd_char_frequency_disabled() {
            scan_big_portable(out, text, delta);
        } else {
            bun_highway::scan_char_frequency(text, out, delta);
        }
    }
}

fn scan_small(out: &mut Buffer, text: &[u8], delta: i32) {
    // PORT NOTE: Zig copied `out.*` into a stack local to avoid unaligned (`align(1)`)
    // RMWs in the loop. The Rust field is naturally aligned, so operate on `out` directly
    // (same treatment as `scan_big`).
    for &c in text {
        // Indices follow `NameMinifier::DEFAULT_TAIL` order
        // (`a-zA-Z0-9_$` → 0..63), matching `scan_big` which writes digits
        // at `out[52 + i]`. The Zig original (`char_freq.zig:79`) used `53`,
        // which shifted `'0'` to 53 and made `'9'` collide with `'_'` at 62,
        // leaving slot 52 cold for `<32`-byte inputs and slightly skewing
        // minified-name ranking when digits/underscores appear.
        let i: usize = match c {
            b'a'..=b'z' => c as usize - b'a' as usize,
            b'A'..=b'Z' => c as usize - (b'A' as usize - 26),
            b'0'..=b'9' => c as usize + (52 - b'0' as usize),
            b'_' => 62,
            b'$' => 63,
            _ => continue,
        };
        out[i] += delta;
    }
}

// ported from: src/js_parser/ast/CharFreq.zig

fn scan_big_portable(out: &mut Buffer, text: &[u8], delta: i32) {
    scan_small(out, text, delta);
}

#[cfg(not(test))]
fn simd_char_frequency_disabled() -> bool {
    static DISABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DISABLED.get_or_init(|| std::env::var_os(DISABLE_SIMD_CHAR_FREQUENCY_ENV).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_freqs(scans: &[(&[u8], i32)]) -> Buffer {
        let mut freqs = [0; CHAR_FREQ_COUNT];

        for &(text, delta) in scans {
            if delta == 0 {
                continue;
            }

            for &c in text {
                let index = match c {
                    b'a'..=b'z' => c as usize - b'a' as usize,
                    b'A'..=b'Z' => c as usize - b'A' as usize + 26,
                    b'0'..=b'9' => c as usize - b'0' as usize + 52,
                    b'_' => 62,
                    b'$' => 63,
                    _ => continue,
                };

                freqs[index] += delta;
            }
        }

        freqs
    }

    #[test]
    fn scan_matches_reference_for_small_and_big_inputs() {
        let scans: &[(&[u8], i32)] = &[
            (b"", 4),
            (b"abcXYZ09_$ ignored-\xff", 2),
            (
                b"0123456789_$_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
                3,
            ),
            (
                b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$!",
                -1,
            ),
            (b"delta-zero-should-not-change-012_$", 0),
        ];

        let mut freq = CharFreq::default();
        for &(text, delta) in scans {
            freq.scan(text, delta);
        }

        assert_eq!(freq.freqs, reference_freqs(scans));
    }

    #[test]
    fn include_accumulates_all_frequency_slots() {
        let mut left = CharFreq::default();
        left.scan(b"abcABC012_$abcABC012_$abcABC012_$abcABC012_$", 2);

        let mut right = CharFreq::default();
        right.scan(b"zzzZZZ999___$$$zzzZZZ999___$$$zzzZZZ999___$$$", -3);

        let expected = reference_freqs(&[
            (b"abcABC012_$abcABC012_$abcABC012_$abcABC012_$", 2),
            (b"zzzZZZ999___$$$zzzZZZ999___$$$zzzZZZ999___$$$", -3),
        ]);

        left.include(&right);

        assert_eq!(left.freqs, expected);
    }
}
