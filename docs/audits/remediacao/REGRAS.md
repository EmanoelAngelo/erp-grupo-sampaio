# Regras da remediação dos 210 gaps de prontidão

Missão: corrigir as 210 fichas `GAP-PRD-001..210` de `docs/audits/DEVORA-PRODUCTION-READINESS-AUDIT.md` até que a pergunta "Se Emanuel fornecer agora todas as credenciais, certificados, dados empresariais, informações do contador e equipamentos externos ainda pendentes, o DEVORA precisará de MAIS PROGRAMAÇÃO antes do go-live?" possa ser respondida **NÃO**. Registro canônico: `docs/audits/remediacao/gaps.json`. Plano por frente e lote: `docs/audits/remediacao/plano.json`.

## 1. Proteção absoluta da instalação da loja

- **A pasta `C:\Users\User\Desktop\Grupo Sampaio` é a instalação do dono.** A API dele roda ali com `tsx watch` (porta 8787) e o Vite na porta 3000. Editar qualquer arquivo importado naquela pasta reinicia a API, e o boot aplica migrações no banco operacional. **Nunca edite, crie ou apague nada lá.** Trabalhe só na worktree da sua frente.
- **Nunca chame `localhost:8787` nem `localhost:3000`** (nem 127.0.0.1, nem pelo navegador, nem por curl). Nunca suba servidor nessas portas. As suítes de teste já recusam essas portas (GAP-PRD-135); não desfaça esse guarda.
- **Banco operacional** `C:\Users\User\Desktop\Grupo Sampaio\server\data\grupo-sampaio.db`: só pode ser aberto com `new DatabaseSync(caminho, { readOnly: true })`, e só para confirmar um fato. Nunca escreva, nunca migre, nunca rode seed, nunca copie para dentro do repositório.
- Stack descartável (quando precisar de E2E): porta da API = porta da sua frente em `plano.json`; porta do frontend = porta + 10. Sempre com `DEVORA_IGNORE_DOTENV=true`, `DEVORA_DATABASE_PATH` e `TEST_DATABASE_PATH` iguais e apontando para um arquivo numa pasta temporária do sistema (`os.tmpdir()`), `DEVORA_UPLOADS_DIR` temporário, `VITE_API_BASE_URL=http://localhost:<sua porta>`. Encerre o que subiu antes de terminar.
- Nenhuma chamada externa real (SEFAZ, Asaas, SMTP, transportadoras, Google, Supabase, maquininha). Todo provedor externo é testado por adapter fake ou `fetch` dublado. Nenhuma credencial real em código, teste, log ou commit. Nunca imprima segredo.

## 2. O que é "resolvido"

- Status finais permitidos: `RESOLVED_PROVEN`, `RESOLVED_BY_ROOT_CAUSE`, `FALSE_POSITIVE_PROVEN`, `EXTERNAL_CONFIGURATION_REQUIRED`, `EXTERNAL_HARDWARE_REQUIRED`, `OWNER_DECISION_REQUIRED`, `NOT_APPLICABLE_PROVEN`. Se não conseguir concluir, use `OPEN` e diga exatamente o que falta — nunca esconda.
- **Externo só é externo se, com o insumo em mãos, nenhuma linha de código precisar ser escrita.** Portanto: implemente todo o software (adapter, fila, tela, validação, estado, erro, retry, guarda de ambiente) e deixe só a credencial, o certificado, o hardware ou a homologação para o dono.
- **Decisão do dono** só fica como decisão se o software já oferece o mecanismo: quando a escolha muda comportamento, implemente a configuração com padrão seguro e tela para escolher.
- **Adapter fake/teste** nunca pode operar em produção: guarda no servidor, baseada em `DEVORA_API_ENV` **e** em `NODE_ENV=production`, com teste que prova a recusa.
- **Não invente tributação.** Quando a regra depende do contador, o sistema pergunta (prontidão com dono "contador"), não chuta.
- `FALSE_POSITIVE_PROVEN` exige prova executada (teste verde contra o comportamento descrito, ou arquivo:linha que o torna inalcançável). Não use para encolher o backlog.
- Dados já existentes no banco real (linha `mock`, NF 9991, OS legada, lançamentos antigos): o código deve oferecer o caminho para corrigir (tela, rota ou passo de migração seguro), sem aplicar no banco real agora.

## 3. Como trabalhar cada gap

1. **Revalidar** no HEAD da sua worktree: `CONFIRMED`, `FALSE_POSITIVE`, `ALREADY_FIXED_BY_OTHER_CHANGE`, `DUPLICATE_OF:<id>`, `EXTERNAL_ONLY`, `OWNER_DECISION`, `NOT_APPLICABLE` — com prova.
2. **Teste vermelho primeiro** para bug real (harness supertest sobre `createApp`, ou teste de serviço, ou teste de tela com `fetch` dublado). Depois a correção. Depois verde.
3. Rode só o que é seu: `cd server && npx vitest run <arquivos> --reporter=dot`, `npx vitest run <arquivos de tela> --reporter=dot`, `npx tsc --noEmit -p server/tsconfig.json`, `npx tsc --noEmit -p tsconfig.app.json` e `npx eslint <arquivos tocados> --max-warnings 0` (frontend na raiz; servidor dentro de `server/`). A suíte completa é trabalho do verificador da frente.
4. **Causa raiz**: se vários gaps têm a mesma causa, corrija a causa uma vez e revalide cada gap.

## 4. Onde colocar o código (para a junção dos branches não virar guerra)

- Prefira **arquivos novos**: serviço novo em `server/src/services/...`, roteador novo montado com uma linha, módulo de cliente novo em `src/lib/api/<dominio>.ts`, página nova. Edite `server/src/routes/v1/core.ts`, `src/lib/api/core.ts`, `src/router/gsRoutes.tsx` e `src/components/gs/navItems.ts` só no trecho indispensável, sem reformatar nada ao redor.
- Não renomeie nem mova arquivos existentes. Não reformate arquivos inteiros.
- Textos de tela em português do Brasil, no estilo que já existe.

## 5. Banco: nada de passo numerado

- **Não crie `core_migration_step_N` e não altere `CORE_TARGET_VERSION`.** Os passos são contíguos, e frentes paralelas colidiriam.
- Tabela nova: `CREATE TABLE IF NOT EXISTS core_...` na DDL canônica de `server/src/db/schema.ts` (o boot a cria em banco existente). Índices de tabela nova podem ficar na mesma DDL.
- Coluna nova em tabela existente: acrescente na DDL canônica da tabela, **anulável ou com DEFAULT** (o `reconcileCoreSchema` a acrescenta em banco existente).
- Índice sobre coluna nova de tabela existente, reconstrução de tabela, troca de constraint ou correção de dado: **não faça no código de boot**; descreva em `docs/audits/remediacao/migracoes/<FRENTE>.md` (SQL exato e motivo). O integrador cria um único passo de consolidação.
- Coleções de documentos (`db/database.ts`) não têm esquema; mudanças de formato devem ler o formato antigo.

## 6. Dependências

- Só adicione pacote npm quando a missão exigir biblioteca madura (ex.: XMLDSig/C14N, validação XSD). Versão exata fixada, `npm install` dentro da sua worktree, e registre no journal o nome, a versão e o motivo.

## 7. Commits e journal

- Commits temáticos em português, prefixo convencional (`fix(fiscal): …`, `feat(workshop): …`), com os IDs dos gaps no título ou no corpo, terminando com a linha `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. `git add` só dos seus arquivos. Nunca `push`, nunca `amend` de commit alheio, nunca `--no-verify`.
- **Journal**: acrescente uma linha JSON por gap em `docs/audits/remediacao/journal/<FRENTE>.jsonl` e comite junto com a correção:

```json
{"id":"GAP-PRD-001","lote":"P1","revalidacao":"CONFIRMED","prova_revalidacao":"…","causa":"…","implementacao":"…","arquivos":["…"],"testes":"arquivos e resultado","commits":["<sha curto>"],"status_final":"RESOLVED_PROVEN","pendente_externo":"o que Emanuel ainda precisa fornecer, ou vazio","depende_de":"outra frente/gap, ou vazio","observacoes":"…"}
```

- Se um gap depende de mudança de outra frente, implemente o seu lado, registre `depende_de` e não edite o domínio alheio além do mínimo.
