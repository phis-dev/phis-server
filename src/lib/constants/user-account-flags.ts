/**
 * What an account says about itself, as bit flags.
 *
 * Positions are fixed from the first row that carries them: moved, every stored value would quietly
 * start meaning something else.
 *
 * `ThemeLight` and `ThemeDark` are the account's Theme choice, and the third answer is the absence of
 * both -- an account that has chosen neither half is followed by the browser. That is why this is two
 * bits here rather than a column of its own: the schema keeps every such answer in `flags`, and a
 * column would be the one place a reader has to remember an exception. It also means a new account is
 * already right at `flags = 0`, with nothing to backfill.
 *
 * Both bits set is not a state anything writes -- the write path always sets one and clears the other
 * -- and it is read as "neither", because a contradiction is not a choice.
 */
export const PhiUserAccountFlag = {
  Disabled: 1 << 0,
  MustChangePassword: 1 << 1,
  ThemeLight: 1 << 2,
  ThemeDark: 1 << 3,
} as const;
