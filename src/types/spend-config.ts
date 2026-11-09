/**
 * One scope's token ceiling.
 *
 * An object rather than a bare number because the ledger's scope limit is already a record in
 * `SpendReservationPolicy`, and a config shape that mirrors the runtime one cannot drift from
 * it silently. Absent `maxTokens` is the same as an absent scope: observe only.
 */
export interface OcxSpendScopeConfig {
  /**
   * Tokens the scope may hold at once, counting settled spend, open reservations and
   * unresolved spend. A reservation is the request's whole input plus its enforceable output
   * ceiling, so this is compared against a number that assumes every cached prefix misses.
   *
   * There is no default. A ceiling is a number only the operator knows -- it depends on the
   * plan, the account roster and what the install is for -- and the recorded lesson from the
   * observational phase of #4546 is that guessing one is worse than shipping none.
   */
  maxTokens?: number;
}

/**
 * Durable spend ceilings (#4546).
 *
 * The three scopes intersect: a request is admitted only when its own root workflow, the
 * identity that would serve it, and the pool it would draw from all have room. That is what
 * makes the ceiling hold against a caller that mints a fresh root id per request -- the root
 * is new, the identity and pool are not.
 *
 * Every field is optional and an empty section is the same as no section at all.
 */
export interface OcxSpendConfig {
  /** Ceiling for one root workflow -- the user-visible task, including its whole fan-out. */
  root?: OcxSpendScopeConfig;
  /** Ceiling for one authenticated identity, across every root it serves. */
  identity?: OcxSpendScopeConfig;
  /** Ceiling for one account pool, across every identity in it. */
  pool?: OcxSpendScopeConfig;
  /**
   * Days a dormant scope's accounting is retained. Default 7.
   *
   * A scope is dropped only when it is both idle and under its ceiling, so shortening this
   * cannot hand an exhausted scope a fresh allowance.
   */
  retentionDays?: number;
}
