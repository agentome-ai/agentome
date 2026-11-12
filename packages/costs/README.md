# @agentome/costs

What a run cost, from the `usage` events of its transcript. There is no price table of our own
: prices come from [LiteLLM](https://github.com/BerriAI/litellm)'s
`model_prices_and_context_window.json`, vendored here as `prices.json`.

- What a run burned is counted by one function, `countedUsage(events)` of `@agentome/shared`:
  each API message counts once, at the latest report of its `messageId`, because the CLI repeats
  an answer's usage on every line it splits the answer into; a report without a message id (the
  run total of the `result` line) counts as it is; events are read in `seq` order, each position
  once. The worker's launcher counts the run's token limit by it, and `normalizeUsage` writes the
  ledger by it, so that the limit and the ledger cannot disagree.
- `normalizeUsage(events)` sums what `countedUsage` counts into one row per model: the rows that
  become `cost_events`. The worker sends them with finish.
- `priceUsage({ model, tokensIn, tokensOut, tokensCacheRead, tokensCacheWrite })` returns
  `{ usd, matchedModel }`. `usd` is a decimal string with six places, as `cost_events.usd` stores
  it, or `null` when there is no honest price; the tokens are recorded either way. The server
  prices every row at finish, so a seat reports tokens and never dollars.
- `isKnownModel(model)` and `KNOWN_MODELS`.

## What `usd` means

An estimate at API list prices. A subscription charges nothing per token, so for a run under
one `usd` is what the run would have cost with an API key. The interface says so wherever it
shows the number, and never presents it as money spent.

## Build

The server imports this package, and the Docker image runs the server from `dist/`, so `pnpm build`
compiles it like `shared` and `db`: `dist/src/` and, beside it, `dist/prices.json`. Development and
the tests read `src/`; the `agentome-dist` export condition picks the build (see the `Dockerfile`).

## Prices

`prices.json` holds `source`, `generatedAt` and the `models`, with the keys of every object in
order. To refresh it (needs the network and Node 22.18 or newer):

```sh
pnpm --filter @agentome/costs update-prices
```

The script downloads LiteLLM's table and keeps the Claude models that have an input and an output
price above zero and that Anthropic, Bedrock or Vertex AI list (or whose name starts with
`claude`); Bedrock lists other vendors' models too, and those are dropped. It also keeps OpenAI's
own text models under their own names (`gpt-…`, `o<n>…`, `codex…`), which are what a Codex agent
runs. A model behind a gateway under a name of the company's own has no price here. Each entry is cut to
seven fields: the five prices (the hour-long cache write among them), `litellm_provider` and
`max_input_tokens` (the pricing reads only the prices). The script prints how many models it kept and what changed, and leaves the file alone
when nothing did. Commit the result in a pull request: a price changes in review.

## Model names

A name is matched exactly, else without its `anthropic/`, `bedrock/` or `vertex_ai/` prefix,
else a dated name (`claude-sonnet-4-5-20250929`) without its date, or an undated one with its
date when the table has exactly one. Any other name has no price: a name that only resembles a
known model is not that model.

## Where the estimate is low

A cache write is priced by how long it lives: Claude Code caches for an hour, at
`cache_creation_input_token_cost_above_1hr`, 1.6 times the five-minute rate. Otherwise the
price is flat per token. The table does not carry LiteLLM's higher rates for long contexts
(`*_above_200k_tokens`, `*_above_100k_tokens`) or for the batch and priority tiers, and the sums
per model no longer show the size of each call's context. A call that falls under one of these
tiers is priced at the base rate. A model with hour-long cache writes and no hour-long rate in the
table is not priced.
