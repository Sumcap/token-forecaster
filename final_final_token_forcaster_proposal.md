# Token Forecaster, cool side project or useful?

I built a thing that tries to predict output tokens from a prompt inside of a conversation and I want to know your take if this is useful or just a cool tool and maybe share some ideas on how would I improve it.

## Main Motives


I started with a problem, before I send a plan or send out an order to an LLM to implement XYZ I only know what it did cost after we get the output which sometimes gets truncated (specially for really long agentic loops) and could waste my remaining usage in a task that i did not want to put that much effort into.

**Main take**: Most people driving an agent have zero intuition for what a turn costs, and nothing in the loop teaches them.


So i've created something like this, a forecast chip that shows the expected cost of the turn before you send it, plus a running ledger:

![example_of_sheep_app](https://gist.githubusercontent.com/PolpEdu/805a7a51b5f52d51919c18a93d07ac58/raw/forecast-chip-and-ledger-openai.png)

*(UI mockup of the target surface. The predictor and the calibration numbers below are real.)*



## What exists today (only data analysis, interesting but not that useful)


A colleague of mine already had built an app called "sheep-manager" where would I customize and execute agent-loops to sort out and implement my linear tasks along with a tracker that tracks how much a session did cost in terms of usage % (one of the use cases we gave it)

![tracker_sheep](https://gist.githubusercontent.com/PolpEdu/805a7a51b5f52d51919c18a93d07ac58/raw/cost-and-tokens-openai.png)

And how much of your plan you have burned:

![yeye](https://gist.githubusercontent.com/PolpEdu/805a7a51b5f52d51919c18a93d07ac58/raw/plan-usage.png)

But every tool that I see out there (including mine) answers the same question: *"what did it cost?"* and never *"what will it cost?"* which is also a very important question.

*"Should i do this with 90% usage left?"* is a question that still haunts me to this day even from the days of Davinci or Ada counting the API tokens every cent had to count for a broke colleage student (lmao).

## How it works


The predictor reads the prompt and the conversation state and outputs an expected output-token range

![forecast](https://gist.githubusercontent.com/PolpEdu/805a7a51b5f52d51919c18a93d07ac58/raw/how-it-works-signals.png)


There is no LLM call inside. The forecast is a lookup over ~16,000 real API calls I recorded from actual agent sessions:

1. **Find similar past calls.** Group history from very specific (same model + reasoning + task shape) to very broad (all calls pooled), and use the most specific group that has at least 100 samples.
2. **Read off what those replies did.** Take the quantiles of their lengths: p50, p90, p99. That range is the forecast. No fitting at request time, just a lookup.
3. **Adjust with what the session knows.** A small trained correction nudges the range using the current session (loop depth, how big previous replies were).

![ladder](https://gist.githubusercontent.com/PolpEdu/805a7a51b5f52d51919c18a93d07ac58/raw/how-it-works-ladder.png)

Because some group always matches (worst case, the pool of all calls), a brand-new user gets a forecast on turn one, with zero history and zero telemetry... (cold start is a first-class case, not a degraded mode)

The output is a distribution, not a number: p50 / p90 / p99. The p90 is the one that matters, because cutting a reply off mid-file costs far more than reserving a bit of slack, so the loss function prices shortfall ~9x higher than slack and the forecast leans safe on purpose.

On held-out calls the predictor never trained on, the bands keep their promise: about half the turns land under p50 and 9 in 10 under p90:

![telemetry](https://gist.githubusercontent.com/PolpEdu/805a7a51b5f52d51919c18a93d07ac58/raw/cold-start-vs-telemetry.png)

## Honest limits afaik

- The method is model-agnostic, but the current numbers are not: the ~16,000 calls are Claude agentic-coding traffic. A GPT profile is one pipeline run away, but that data has to exist first.
- It forecasts one workload well: agentic coding. Other workloads want their own profile (!!!)
- The strongest signals turned out to be configuration and session state, not prompt semantics. Every "smart" semantic feature I tried failed my adoption gate (a signal only ships if it beats the current predictor on held-out data, with the whole confidence interval below zero). The rejections stay on record so I do not retry them by accident. I think that is a finding, not a gap: the cheap signals carry the value.
- p90 is a promise about frequency, not each turn. One turn in ten lands above it by design.

## Conclusion
I’ve always been interested in understanding how LLMs behave, not just using them. This project was a way for me to study that behavior hands-on: take something that feels unpredictable, how much a model will write, and see whether real usage data could make it predictable. It also led me to a practical problem: today, you only learn what a turn cost after it runs.


## So, my ask

  I am not pitching a product. I want your read on whether this primitive belongs in the loop at all, and where:

  - Would a pre-send forecast actually change how people prompt, or does it become wallpaper after a week? You see more user behavior than I do for sure..
  - Would agent frameworks use a pre-generation preflight (summarize, split, or link an artifact before the call), or is handling truncation after the fact fine?
  - If a provider ever wanted this, what surface fits: a `forecast_output_tokens` sibling to token counting, a response header, or nothing, because it belongs client-side?


Just to clarify: A paragraph of written feedback is plenty. A "this is useless because X" is just as valuable to me as a yes.
