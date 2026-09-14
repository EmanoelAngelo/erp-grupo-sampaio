# Grupo Sampaio — Gestão Empresarial

ERP multiempresa para as operações do Grupo Sampaio: lojas, oficina,
e-commerce, financeiro, CRM e integrações.

> **Estado honesto do projeto.** O sistema roda: balcão, estoque, caixa,
> vendas, financeiro, compras, oficina, e-commerce, CRM, locação, BI e
> conciliação estão sobre banco central e cobertos por teste. Os módulos que
> dependem de terceiros (NF-e/NFC-e, Asaas, TEF, transportadoras, impressão
> silenciosa, banco central Supabase) têm o código pronto e **não estão
> homologados** — falta credencial ou equipamento, e enquanto faltar a tela diz
> o que falta em vez de oferecer botão que falha.
>
> O quadro completo, módulo a módulo, está em
> [`docs/ESTADO-ATUAL.md`](docs/ESTADO-ATUAL.md) — é ele que responde pelo
> estado do sistema. Nenhum módulo é declarado "pronto para produção" sem
> evidência.

**Versão 1.0.0** — canal `stable`.

## Requisitos

- **Node.js 22+** (o banco usa `node:sqlite`, nativo a partir do Node 22)
- npm 9+
- Windows 10/11, macOS ou Linux

## Instalação

```bash
npm install && npm install --prefix server
```

### Windows: liberar a execução de scripts

No PowerShell, `npm` é um script `.ps1`. Com a política padrão do Windows ele
falha com *"execução de scripts foi desabilitada neste sistema"* — o erro
aparece já no `npm install` e costuma ser confundido com problema de instalação
do Node. Libere uma vez, para o seu usuário:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`RemoteSigned` permite scripts locais e exige assinatura apenas nos baixados da
internet. Não é necessário no Git Bash, no cmd.exe, no macOS nem no Linux.

Copie o exemplo de ambiente e defina os segredos do backend:

```bash
cp .env.example .env
```

`DEVORA_JWT_SECRET` e `DEVORA_ENCRYPTION_KEY` são obrigatórios. Em produção o
servidor **recusa subir** com os valores padrão de desenvolvimento.

## Banco de dados

O banco central é um arquivo SQLite (`server/data/grupo-sampaio.db` por
padrão, configurável em `DEVORA_DATABASE_PATH`).

```bash
npm run db:migrate --prefix server
npm run db:bootstrap --prefix server     # o mesmo que npm run db:seed --prefix server
```

O **bootstrap de produção** cria só o estrutural: as **seis operações reais** —
Preço Justo, Gringa, Me Mimei, Conceito, PJ Motors e Oficina —, as duas
oficinas oficiais e **um administrador inicial**: login `admin`, com a senha de
`DEVORA_BOOTSTRAP_ADMIN_PASSWORD`, administrador em todas as operações. Nenhuma
filial fictícia e nenhuma conta de demonstração. A subida da API faz o mesmo
sozinha, logo depois das migrações.

A conta `admin` nasce com a senha **provisória**: o primeiro login abre a troca
obrigatória, e a API recusa qualquer outra rota até ela
(`API_PASSWORD_CHANGE_REQUIRED`). Ela só é criada quando ainda não existe
administrador do grupo nem conta `admin` (sem distinguir maiúsculas), e o
bootstrap **nunca altera conta existente**: rodar de novo não duplica, não
reseta e não mexe na senha que o dono trocou. Sem a variável, nenhuma conta
nasce — o log avisa e a conferência da implantação bloqueia dizendo o que fazer.

Roteiro da primeira subida: defina `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` no `.env`,
suba a API, entre como `admin`, troque a senha e apague a variável do `.env`.
Gerentes, PDVs e mecânicos o administrador cadastra em **Pessoas › Usuários e
equipe**, cada um com senha provisória.

## Desenvolvimento

```bash
npm run dev:api
```

```bash
npm run dev
```

Frontend em `http://localhost:5173`, API em `http://localhost:8787`.

## Contas de demonstração (só na bancada)

```bash
npm run db:seed:dev --prefix server
```

O **seed de desenvolvimento** cria as contas com que se desenvolve e se testa à
mão — um gestor, um PDV por operação e os técnicos das duas oficinas —, todas
provisórias. Ele **recusa** produção, homologação e o banco operacional
(qualquer arquivo `grupo-sampaio.db`): aponte `DEVORA_DATABASE_PATH` para um
banco de bancada (ex.: `server/data/desenvolvimento.db`). As senhas vêm de
`GRUPO_SAMPAIO_MANAGEMENT_PASSWORD` (gestão) e
`GRUPO_SAMPAIO_OPERATION_PASSWORD` (PDV e oficina); sem elas, cada conta ganha
uma senha gerada, impressa uma única vez. Nenhuma senha fica escrita no
repositório, e o administrador continua sendo o do bootstrap.

## Acesso

**Todo login exige senha** — gestão, balcão e bancada. O sistema já teve dois
caminhos que emitiam sessão sem senha — um acesso por card e, depois, um atalho
de desenvolvimento com os usuários do banco na tela de login. Os dois foram
removidos por inteiro (rotas, cliente e tela), porque trava que depende de
alguém declarar o ambiente não é garantia. Se o `.env` de uma instalação antiga
ainda tiver a linha que ligava um deles, ela não liga nada: em produção a API
recusa subir com ela ligada e diz qual linha apagar, e fora de produção sobe
avisando no log.

O único caminho que dispensa digitar senha é o **token de terminal confiável**,
e ele não é anônimo: um administrador registra o computador uma vez, o terminal
guarda um token opaco e o token é revogável.

A equipe da oficina entra por **`/oficina/login`**, uma porta separada da tela
do escritório.

## Qualidade

```bash
npm run lint && npm run type-check && npm run test && npm run build
```

## Arquitetura

```
Cliente React
      ↓  HTTPS + JWT
API Express  (/api/v1)
      ↓
Services / transações
      ↓
SQLite central (WAL)  +  trilha de auditoria
```

Detalhes em [`docs/ARQUITETURA-NUCLEO.md`](docs/ARQUITETURA-NUCLEO.md).

Invariantes garantidos pelo **banco**, não por disciplina de código:

- estoque nunca fica negativo — `CHECK (quantity >= 0)`
- uma venda baixa estoque **uma vez** — `UNIQUE` no razão de movimentos
- uma venda gera **um** lançamento financeiro — `UNIQUE (origin_type, origin_id)`
- isolamento entre operações — `company_id` derivado da sessão, nunca do cliente

## Segurança

- Senhas com **Argon2id**; hashes SHA-256 legados são aceitos uma única vez no
  login e reescritos automaticamente.
- Access token + refresh token com rotação.
- Bloqueio por tentativas e rate limit **no servidor**.
- O `companyId` vem sempre do vínculo do usuário no banco — o cliente não
  escolhe o tenant.

## Administração

- `/sistema/painel` — painel do gestor
- `/pdv` — ponto de venda
- `/sistema/produtos`, `/sistema/estoque`, `/sistema/clientes`
- `/sistema/caixa`, `/sistema/vendas`, `/sistema/financeiro`
