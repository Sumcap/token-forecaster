# Call com Kotake, 3 Set 2026: perguntas

## Validar a ideia primeiro

O token-manager, prever tokens de acordo com as inputs correndo localmente sem rede, é útil? Que forma é que ele vê isto de forma a escalar para um end user product bacano. "Se eu conseguir prever com um grau de confiança >95% como é que transformo isso numa coisa útil para o user que faz prompts".

- O que é que o user do Codex quer mesmo saber antes de carregar enter: tokens, quota que sobra, tempo, ou "vai acabar ou não"?
- É mais útil mostrar uma previsão ou deixar o user pôr um limite e o agente adaptar-se? O Codex tem um rollout_budget experimental, nós somos a metade que falta.
- NOT THAT RELEVANT IF NO TIME: Open source: o que ele acha.

## Dashboard com vários agentes

A ideia surgiu quando estavamos a fazer uma plataforma para ter flows automaticamente juntamente com agents que correm mais perto de ti.

(meetup Roppongi, 7 Ago) ele NÃO falou de loops. Falou do workflow dele: código à mão → Codex CLI → Codex app com todos os tickets em paralelo → agora lança tasks à mão e pergunta progresso por voz. Loops foram outros: CyberAgent com goal mode para tarefas de horas; Symphony da OpenAI (issue vira agente), que dizem que não vai ser produto.

- Vale a pena gastar tempo nisto? Simplificando o UI e afins para um end user.
- Os flows é uma cena que vale a pena manter, o que ele acha? -> ele corre tudo em paralelo no app, não flows. Perguntar o que separa "muitas tasks em paralelo" de "um flow que corre sozinho".
- Ele corre tickets em paralelo no Codex app: o que ainda lhe falta quando tem muitas tasks ao mesmo tempo? Onde perde o fio?
- NOT THAT RELEVANT IF NO TIME: que prompts dão melhor output por token, e routing por tipo de prompt para agentes diferentes.

## Review de código gerado por agentes

Como é que fazem review de código gerado por agentes numa empresa AI-based em larga escala.

- Ele já contou as regras: 2 reviewers, autor tem de perceber, Codex review "não se aceita tal como vem". Perguntar como funciona na prática: como sabem que o autor percebeu? Quanto do Codex review é mau?
- O que é que uma ferramenta devia fazer para tornar a review de código de agente mais fácil? Porta para a ideia do Coimbra e para o repo-rescue dele.

## Fechar

- "Se este problema fosse teu, o que construías primeiro e o que não construías de certeza?"
- "Qual é o melhor canal para te mandar coisas? siga criar grupo?"

## Notas

- Números dele (trabalho de casa): PRs 300 a 500 linhas, 2 reviewers, 2 commits no Codex CLI.
- Números nossos, se perguntar quão bom é: p90 acerta 90.5% em 4.232 calls held-out, banda 10 a 17% mais estreita que o baseline, 46 mil observações. Caveat primeiro: histórico de um user, cold start OpenAI ainda é um prior fixo.
- Nomes: Sol, Terra, Luna e reasoning effort. Não "Companion" nem "Max" como modelo.
- A pergunta da interface é a que mais importa para produto: decide se isto é um wrapper ou uma integração a sério.
