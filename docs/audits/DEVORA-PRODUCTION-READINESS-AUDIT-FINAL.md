# DEVORA ERP — Reauditoria final de prontidão de produção

Gerado a partir da auditoria original (`DEVORA-PRODUCTION-READINESS-AUDIT.md`, 210 fichas), do journal de remediação (`docs/audits/remediacao/journal/`, consolidado em `gaps.json`), dos portões finais, do walkthrough de API, da reauditoria independente com contraprova e da conferência só-leitura do banco da loja.

## 1. Resumo executivo

- **210 de 210 fichas contabilizadas**; nenhuma desapareceu.
- **176** resolvidas no software; **19** dependem de configuração externa; **3** de equipamento; **12** de decisão do dono.
- **Pendências programáveis restantes: 0.**
- Reauditoria independente: 210 fichas com veredito; 0 contestadas e decididas pelo integrador.
- Corrigidas depois da reauditoria (a reauditoria achou falta de código; conserto com teste vermelho primeiro e verificador adversarial): GAP-PRD-028 → RESOLVED_PROVEN; GAP-PRD-153 → RESOLVED_PROVEN; GAP-PRD-168 → EXTERNAL_CONFIGURATION_REQUIRED.
- **Confirmação explícita:** OPEN = **0**; fichas de BUG, MISSING_IMPLEMENTATION, PARTIAL_IMPLEMENTATION, INCONSISTENT_CONTRACT, SECURITY_RISK, DATA_INTEGRITY_RISK, DEPLOYMENT_RISK ou UX_OPERATIONAL_RISK ainda pedindo código = **0**.
- **Se Emanuel fornecer agora todas as credenciais, certificados, dados empresariais, informações do contador e equipamentos externos ainda pendentes, o DEVORA precisará de MAIS PROGRAMAÇÃO antes do go-live?** → **NÃO** (seção 11).
- Portões finais: 18 de 18 passaram.
- Banco da loja: preservado — integrity ok, FK 0, versão 84 (nenhuma migração aplicada), 339 tabelas, contagens de negócio iguais; api_request_logs só com a poda de 30 dias do dono e 3 requisição(ões) externa(s) à missão.

## 2. Estado do Git

| | |
| --- | --- |
| HEAD inicial da remediação | `dc48841` (a árvore do dono) |
| HEAD final | `99d01b3` (branch `int/b`) |
| Commits entre os dois | 356 (29 junções de frente/grupo) |
| Push | nenhum — a integração fica local, para o dono revisar |

### Junções

- `a250a117` merge(remediacao): integra a rodada 3 da verificacao final - o municipio do IBGE conferido antes de numerar e no emitente (GAP-PRD-028) (branch int/r3-ibge)
- `4878ad26` merge(remediacao): integra a rodada 3 da verificacao final - NF-e de homologacao fora da producao e o cursor DF-e pelo ultNSU da SEFAZ (GAP-PRD-168) (branch int/r3-dfe)
- `bfb7c04e` merge(remediacao): integra a rodada 2 da sessao - a troca exige a prova, as abas dividem a sessao e o logout chega pelo refresh (branch int/r2-sessao)
- `1b4c025e` merge(remediacao): integra a rodada 2 da idempotencia - chaves do servidor reservadas, telas depois do 422 e o checkout do carrinho inteiro (branch int/r2-idem)
- `07dda2f4` merge(remediacao): integra a verificacao final do GAP-PRD-028 - o codigo IBGE sai do nome da cidade (branch int/res-ibge)
- `f239ecd6` merge(remediacao): integra a verificacao final do GAP-PRD-168 - o NSU da Distribuicao DF-e por ambiente (branch int/res-dfe-amb)
- `5c767385` merge(remediacao): integra os residuos do endurecimento pos-walkthrough (branch int/res-idem-viz)
- `51e46d9d` merge(remediacao): integra os residuos do endurecimento pos-walkthrough (branch int/res-idem-tela)
- `eb0f4fc5` merge(remediacao): integra os residuos do endurecimento pos-walkthrough (branch int/res-sessao)
- `83a6749b` merge(remediacao): integra a correcao da reauditoria do GAP-PRD-168 (branch int/hard-168)
- `7b8e41d9` merge(remediacao): integra a correcao da reauditoria do GAP-PRD-028 (branch int/hard-028)
- `2c59d188` merge(remediacao): integra a recusa da mesma Idempotency-Key com outra mercadoria (branch int/hard-idem)
- `481cd242` merge(remediacao): integra o endurecimento do logout - o access token sai junto com o refresh (branch int/hard-sessao)
- `615ca386` merge(remediacao): integra a correcao da reauditoria do GAP-PRD-153 (branch int/hard-153)
- `3c9a543e` merge(remediacao): integra o grupo LEG (GAP-PRD-075, branch int/leg)
- `a6ba71a0` merge(remediacao): integra o grupo ESQ (GAP-PRD-140, GAP-PRD-142, branch int/esq)
- `00cc0072` merge(remediacao): integra o grupo BUILD (GAP-PRD-210, branch int/build)
- `660830b3` merge(integracao): junta a integracao (ECO e consertos) a frente FIS
- `dccc17b9` merge(remediacao): integra a frente FIS (branch rem/fis)
- `4f44f67e` merge(remediacao): integra a frente ECO (branch int/eco, juntada de rem/eco)
- `4935bbbf` merge(remediacao): integra a frente ECO (branch rem/eco)
- `fb4cb82c` merge(remediacao): integra a frente PAG (branch rem/pag)
- `bc19ac09` merge(remediacao): integra a frente DEP (branch rem/dep)
- `a63470c9` merge(remediacao): integra a frente SEG (branch rem/seg)
- `22abba1b` merge(remediacao): integra a frente OFI (branch rem/ofi)
- `9a004b2b` merge(remediacao): integra a frente FIN (branch rem/fin)
- `067165c2` merge(remediacao): integra a frente EST (branch rem/est)
- `8eddde10` merge(remediacao): integra a frente EML (branch rem/eml)
- `6e0428f5` merge(remediacao): integra a frente LOG (branch rem/log)

## 3. Distribuição final

| Status final | Fichas |
| --- | ---: |
| Resolvido e provado (`RESOLVED_PROVEN`) | 174 |
| Resolvido pela causa-raiz (`RESOLVED_BY_ROOT_CAUSE`) | 2 |
| Falso positivo provado (`FALSE_POSITIVE_PROVEN`) | 0 |
| Configuração externa (`EXTERNAL_CONFIGURATION_REQUIRED`) | 19 |
| Equipamento externo (`EXTERNAL_HARDWARE_REQUIRED`) | 3 |
| Decisão do dono (`OWNER_DECISION_REQUIRED`) | 12 |
| Não se aplica (provado) (`NOT_APPLICABLE_PROVEN`) | 0 |
| ABERTO (`OPEN`) | 0 |
| **Total** | **210** |

### Pendência programável por categoria de origem

| Categoria (auditoria original) | Fichas | Pendentes programáveis |
| --- | ---: | ---: |
| BUG | 28 | **0** |
| MISSING_IMPLEMENTATION | 28 | **0** |
| PARTIAL_IMPLEMENTATION | 27 | **0** |
| INCONSISTENT_CONTRACT | 26 | **0** |
| SECURITY_RISK | 17 | **0** |
| DATA_INTEGRITY_RISK | 15 | **0** |
| DEPLOYMENT_RISK | 13 | **0** |
| UX_OPERATIONAL_RISK | 25 | **0** |
| OPEN | — | **0** |

### Antes × depois

| | Antes | Depois |
| --- | ---: | ---: |
| Fichas que bloqueavam o go-live | 27 | 0 |
| P0 abertas | 7 | 0 |
| P1 abertas | 36 | 0 |
| P2 abertas | 92 | 0 |
| P3 abertas | 75 | 0 |

## 4. Estado por domínio

Classe = a mais restritiva entre as fichas do domínio: NOT_READY se alguma ainda pede código; senão equipamento; senão configuração externa; senão decisão do dono; senão pronto para go-live controlado. READY_FOR_CONFIGURATION (o software está pronto e só falta preencher a tela) aparece quando a única pendência é configuração que o próprio dono faz.

| Domínio | Estado | Fichas | O que falta de fora |
| --- | --- | ---: | --- |
| Core (núcleo, migração, esquema) | **OWNER_DECISION_REQUIRED** | 25 | GAP-PRD-188 |
| Auth / Segurança | **EXTERNAL_CONFIGURATION_REQUIRED** | 40 | GAP-PRD-027, GAP-PRD-054, GAP-PRD-055, GAP-PRD-151, GAP-PRD-160, GAP-PRD-165, GAP-PRD-198 |
| Gestor (painel, BI, equipe) | **OWNER_DECISION_REQUIRED** | 17 | GAP-PRD-054, GAP-PRD-165, GAP-PRD-166 |
| PDV — Preço Justo | **EXTERNAL_HARDWARE_REQUIRED** | 27 | GAP-PRD-014, GAP-PRD-023, GAP-PRD-082, GAP-PRD-098, GAP-PRD-163, GAP-PRD-203 |
| PDV — Gringa | **EXTERNAL_HARDWARE_REQUIRED** | 22 | GAP-PRD-014, GAP-PRD-082, GAP-PRD-098, GAP-PRD-163, GAP-PRD-203 |
| PDV — Me Mimei | **EXTERNAL_HARDWARE_REQUIRED** | 21 | GAP-PRD-014, GAP-PRD-082, GAP-PRD-098, GAP-PRD-163, GAP-PRD-203 |
| PDV — Conceito | **EXTERNAL_HARDWARE_REQUIRED** | 21 | GAP-PRD-014, GAP-PRD-082, GAP-PRD-098, GAP-PRD-163, GAP-PRD-203 |
| PDV — PJ Motors | **EXTERNAL_HARDWARE_REQUIRED** | 23 | GAP-PRD-014, GAP-PRD-082, GAP-PRD-098, GAP-PRD-163, GAP-PRD-203 |
| PDV — Oficina | **EXTERNAL_HARDWARE_REQUIRED** | 26 | GAP-PRD-014, GAP-PRD-024, GAP-PRD-082, GAP-PRD-098, GAP-PRD-163, GAP-PRD-203 |
| Pagamentos | **EXTERNAL_CONFIGURATION_REQUIRED** | 17 | GAP-PRD-017, GAP-PRD-083 |
| TEF | **EXTERNAL_HARDWARE_REQUIRED** | 12 | GAP-PRD-014, GAP-PRD-203 |
| Asaas | **EXTERNAL_CONFIGURATION_REQUIRED** | 16 | GAP-PRD-017, GAP-PRD-034 |
| Estoque | **OWNER_DECISION_REQUIRED** | 19 | GAP-PRD-165, GAP-PRD-166 |
| Compras | **EXTERNAL_CONFIGURATION_REQUIRED** | 12 | GAP-PRD-088, GAP-PRD-128, GAP-PRD-168 |
| Financeiro | **READY_FOR_CONFIGURATION** | 20 | GAP-PRD-083, GAP-PRD-088, GAP-PRD-171 |
| Fiscal | **EXTERNAL_CONFIGURATION_REQUIRED** | 24 | GAP-PRD-023, GAP-PRD-024, GAP-PRD-041, GAP-PRD-098, GAP-PRD-129, GAP-PRD-163, GAP-PRD-168 |
| Certificado A1 | **EXTERNAL_CONFIGURATION_REQUIRED** | 6 | GAP-PRD-023, GAP-PRD-041, GAP-PRD-168 |
| Contador | **EXTERNAL_CONFIGURATION_REQUIRED** | 8 | GAP-PRD-129, GAP-PRD-130, GAP-PRD-166 |
| Oficina | **EXTERNAL_CONFIGURATION_REQUIRED** | 23 | GAP-PRD-024, GAP-PRD-188 |
| Equipamentos / QR | **READY_FOR_CONFIGURATION** | 9 | GAP-PRD-112 |
| Kanban | **READY_FOR_CONTROLLED_GO_LIVE** | 2 | nada |
| PJ Motors (motos) | **READY_FOR_CONFIGURATION** | 9 | GAP-PRD-112 |
| Serialização (chassi/IMEI/unidade) | **READY_FOR_CONFIGURATION** | 10 | GAP-PRD-112 |
| E-commerce (loja online) | **EXTERNAL_CONFIGURATION_REQUIRED** | 35 | GAP-PRD-017, GAP-PRD-030, GAP-PRD-034, GAP-PRD-119, GAP-PRD-120 |
| Cliente (portal e conta) | **EXTERNAL_CONFIGURATION_REQUIRED** | 18 | GAP-PRD-027, GAP-PRD-119 |
| Google OAuth | **EXTERNAL_CONFIGURATION_REQUIRED** | 1 | GAP-PRD-027 |
| E-mail | **EXTERNAL_CONFIGURATION_REQUIRED** | 17 | GAP-PRD-034, GAP-PRD-128, GAP-PRD-130, GAP-PRD-160, GAP-PRD-168, GAP-PRD-198 |
| Logística | **EXTERNAL_CONFIGURATION_REQUIRED** | 12 | GAP-PRD-030, GAP-PRD-034, GAP-PRD-119, GAP-PRD-120 |
| Tracking (rastreio) | **EXTERNAL_CONFIGURATION_REQUIRED** | 4 | GAP-PRD-119 |
| Sync / Supabase (central) | **EXTERNAL_CONFIGURATION_REQUIRED** | 9 | GAP-PRD-130 |
| Offline | **OWNER_DECISION_REQUIRED** | 5 | GAP-PRD-046, GAP-PRD-098 |
| Backup | **READY_FOR_CONFIGURATION** | 5 | GAP-PRD-068 |
| Restore | **EXTERNAL_CONFIGURATION_REQUIRED** | 2 | GAP-PRD-154 |
| Deploy (implantação) | **EXTERNAL_HARDWARE_REQUIRED** | 26 | GAP-PRD-013, GAP-PRD-055, GAP-PRD-068, GAP-PRD-082, GAP-PRD-130, GAP-PRD-151, GAP-PRD-154 |

## 5. Dependências externas — "se Emanuel fornecer isso agora, falta alguma linha de código?"

| Dependência | Fichas | Falta código? | Evidência |
| --- | --- | --- | --- |
| Certificado A1 de cada CNPJ | GAP-PRD-023, GAP-PRD-041, GAP-PRD-179 | **NÃO** | GAP-PRD-023: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-041: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-179: RESOLVED_PROVEN |
| Senha do A1 (selada no cofre) | GAP-PRD-023 | **NÃO** | GAP-PRD-023: EXTERNAL_CONFIGURATION_REQUIRED |
| CSC da NFC-e | GAP-PRD-022, GAP-PRD-041 | **NÃO** | GAP-PRD-022: RESOLVED_PROVEN; GAP-PRD-041: EXTERNAL_CONFIGURATION_REQUIRED |
| CSC ID | GAP-PRD-022, GAP-PRD-041 | **NÃO** | GAP-PRD-022: RESOLVED_PROVEN; GAP-PRD-041: EXTERNAL_CONFIGURATION_REQUIRED |
| Dados fiscais do contador (CRT, grupo tributário, regime) | GAP-PRD-021, GAP-PRD-041, GAP-PRD-129, GAP-PRD-178 | **NÃO** | GAP-PRD-021: RESOLVED_PROVEN; GAP-PRD-041: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-129: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-178: RESOLVED_PROVEN |
| NCM / CEST / CFOP / origem por produto | GAP-PRD-129, GAP-PRD-095 | **NÃO** | GAP-PRD-129: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-095: RESOLVED_PROVEN |
| Régua de custo e visibilidade do dinheiro | GAP-PRD-165, GAP-PRD-166 | **NÃO** | GAP-PRD-165: OWNER_DECISION_REQUIRED; GAP-PRD-166: OWNER_DECISION_REQUIRED |
| Asaas (chaves, webhook, produção) | GAP-PRD-017, GAP-PRD-002 | **NÃO** | GAP-PRD-017: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-002: RESOLVED_PROVEN |
| SMTP (e-mail de saída) | GAP-PRD-130, GAP-PRD-160 | **NÃO** | GAP-PRD-130: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-160: OWNER_DECISION_REQUIRED |
| IMAP (NF-e por e-mail) | GAP-PRD-128, GAP-PRD-168 | **NÃO** | GAP-PRD-128: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-168: EXTERNAL_CONFIGURATION_REQUIRED |
| Google OAuth (Entrar com Google) | GAP-PRD-027 | **NÃO** | GAP-PRD-027: EXTERNAL_CONFIGURATION_REQUIRED |
| Transportadoras (Melhor Envio) | GAP-PRD-030, GAP-PRD-119, GAP-PRD-120, GAP-PRD-034 | **NÃO** | GAP-PRD-030: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-119: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-120: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-034: EXTERNAL_CONFIGURATION_REQUIRED |
| TEF (gerenciador e adquirente) | GAP-PRD-014 | **NÃO** | GAP-PRD-014: EXTERNAL_HARDWARE_REQUIRED |
| PinPad / SmartPOS e taxas de operadora | GAP-PRD-014, GAP-PRD-083 | **NÃO** | GAP-PRD-014: EXTERNAL_HARDWARE_REQUIRED; GAP-PRD-083: EXTERNAL_CONFIGURATION_REQUIRED |
| Impressão local (térmica e agente) | GAP-PRD-082, GAP-PRD-203 | **NÃO** | GAP-PRD-082: EXTERNAL_HARDWARE_REQUIRED; GAP-PRD-203: EXTERNAL_HARDWARE_REQUIRED |
| SEFAZ — homologação real | GAP-PRD-003, GAP-PRD-004, GAP-PRD-005, GAP-PRD-019, GAP-PRD-097 | **NÃO** | GAP-PRD-003: RESOLVED_PROVEN; GAP-PRD-004: RESOLVED_PROVEN; GAP-PRD-005: RESOLVED_PROVEN; GAP-PRD-019: RESOLVED_PROVEN; GAP-PRD-097: RESOLVED_PROVEN |
| NFS-e — provedor municipal / Emissor Nacional | GAP-PRD-024 | **NÃO** | GAP-PRD-024: EXTERNAL_CONFIGURATION_REQUIRED |
| Contingência off-line da NFC-e (decisão) | GAP-PRD-098 | **NÃO** | GAP-PRD-098: OWNER_DECISION_REQUIRED |
| Domínio público e HTTPS | GAP-PRD-013, GAP-PRD-153 | **NÃO** | GAP-PRD-013: OWNER_DECISION_REQUIRED; GAP-PRD-153: RESOLVED_PROVEN |
| Proxy (DEVORA_TRUST_PROXY) | GAP-PRD-055 | **NÃO** | GAP-PRD-055: EXTERNAL_CONFIGURATION_REQUIRED |
| Disco do backup (DEVORA_BACKUP_DIR) | GAP-PRD-068 | **NÃO** | GAP-PRD-068: EXTERNAL_CONFIGURATION_REQUIRED |
| Central / Supabase (sincronização) | GAP-PRD-048 | **NÃO** | GAP-PRD-048: RESOLVED_PROVEN |
| Variáveis de produção e segredos antigos | GAP-PRD-151, GAP-PRD-154 | **NÃO** | GAP-PRD-151: EXTERNAL_CONFIGURATION_REQUIRED; GAP-PRD-154: EXTERNAL_CONFIGURATION_REQUIRED |
| Tabela oficial de municípios do IBGE (um comando do dono) | GAP-PRD-028 | **NÃO** | GAP-PRD-028: RESOLVED_PROVEN |
| Decisão sobre a OS #1 do banco da loja (pela tela) | GAP-PRD-188 | **NÃO** | GAP-PRD-188: OWNER_DECISION_REQUIRED |

### Configuração externa (19)

- **GAP-PRD-017** (achado original: "Asaas: credencial só da Preço Justo; as outras cinco operações não cobram até o dono cadastrar chave e token — sem código novo") — **o que falta de fora:** Para Gringa, Me Mimei, Conceito, PJ Motors e Oficina: API key sandbox, token do webhook, URL cadastrada no painel do Asaas de cada conta, homologação, API key de produção testada e pedido de produção. No servidor: GRUPO_SAMPAIO_PUBLIC_URL com HTTPS público e ASAAS_PRODUCTION_ENABLED=true. Reemitir as chaves do Preço Justo.
- **GAP-PRD-023** (achado original: "Certificado real do dono gravado antes da autodetecção: senha NÃO selada, cartão sem titular/conferência — PDV pararia em FISCAL_CERTIFICATE_PASSWORD_REQUIRED; vence em 15/10/2026") — **o que falta de fora:** Emanuel: (1) reenviar o .pfx do A1 da Preço Justo com a senha em Fiscal > Certificado > Substituir; (2) renovar esse A1 antes de 15/10/2026 e enviar pelo mesmo caminho; (3) mandar o A1 de cada uma das outras cinco empresas. Não verifiquei o banco da loja (proibido ou dispensável).
- **GAP-PRD-024** (achado original: "A venda gerada pelo checkout da OS não tem caminho fiscal (serviço sem NFS-e; linha sem produto/NCM; peças não itemizadas)") — **o que falta de fora:** Dono: escolher o modo da NFS-e (o Registro manual funciona já, sem código). Contador: cTribNac, situação no Simples, apuração, retenção e alíquota do ISS. Prefeitura: confirmar a adesão ao Sistema Nacional NFS-e. Emanuel: A1 com senha selada e primeira DPS em produção restrita. Riscos declarados: a DPS 1.00 foi escrita sem o XSD oficial (a homologação é o juiz), e o cancelamento pela API da Sefin não existe (é feito no portal e registrado no sistema).
- **GAP-PRD-027** (achado original: "Login Google (OAuth2/OIDC) não existe — nem rota, nem adapter, nem botão") — **o que falta de fora:** Emanuel: criar no Google Cloud Console um ID de cliente OAuth tipo Aplicativo da Web, com tela de consentimento publicada (openid, email, profile) e URI de redirecionamento = endereço público da loja + /minha-conta/google. Depois colar Client ID e segredo em Sistema > Integrações > 'Entrar com Google (loja)', escolher modo Google e ligar. Pressupõe GRUPO_SAMPAIO_PUBLIC_URL definido e a chave do cofre que sela os segredos já configurada na instalação (não verifiquei no ambiente real).
- **GAP-PRD-030** (achado original: "Melhor Envio: cotação real só em sandbox e só com LOGISTICS_HOMOLOGATION_TESTS=true — em produção o checkout não chama a transportadora") — **o que falta de fora:** Token de PRODUÇÃO do Melhor Envio de cada operação, colado em Loja → Logística (ambiente Produção), com Testar conexão OK. LOGISTICS_PRODUCTION_ENABLED=true no .env da API. E-mail de contato técnico (opcional). A primeira chamada real à produção não foi medida: o contrato da API só foi provado contra fetch dublado.
- **GAP-PRD-034** (achado original: "Configuração operacional do dia 1 ainda não feita: entrega, medidas dos produtos, CEP de origem, Asaas, SMTP") — **o que falta de fora:** Por operação, pelas telas: ligar a entrega e informar a tabela (Loja → Entrega); peso e medidas dos produtos publicados; CEP e endereço completos em Fiscal → Configuração; chave Asaas de produção; token Melhor Envio (opcional se a tabela bastar). No servidor: EMAIL_ENABLED, EMAIL_FROM e EMAIL_SMTP_*, e LOGISTICS_PRODUCTION_ENABLED=true se usar o token de produção.
- **GAP-PRD-041** (achado original: "Cadastro fiscal, série, certificado A1 e CSC: só a Preço Justo tem cadastro/série/certificado; CSC em nenhuma; o A1 da PJ vence em 15/10/2026") — **o que falta de fora:** Emanuel: CNPJ, IE, CRT e endereço com IBGE/CEP de Gringa, Me Mimei, Conceito, PJ Motors e Oficina; séries 55/65; A1 de cada CNPJ; renovar o A1 da Preço Justo antes de 15/10/2026; CSC de homologação e produção de cada CNPJ; grupo tributário com o contador; emitir em homologação e desbloquear produção.
- **GAP-PRD-055** (achado original: "Atrás de proxy reverso sem DEVORA_TRUST_PROXY, as seis operações dividem um balde de 300 req/min e uma falha de refresh (429/5xx) derruba o caixa") — **o que falta de fora:** Emanuel define DEVORA_TRUST_PROXY no .env da publicação com o número de saltos (1 atrás de nginx/Caddy/túnel; 2 com CDN na frente; 0 direto na LAN), reinicia e confere publicacao.estado em /api/v1/core/system/secrets-readiness. Essa rota não tem tela; o estado também sai no log.
- **GAP-PRD-068** (achado original: "Backup local no mesmo disco do banco: DEVORA_BACKUP_DIR não está definido nesta instalação (padrão server/data/backups)") — **o que falta de fora:** Emanuel escreve DEVORA_BACKUP_DIR=<pasta em outro disco, pen drive ou volume> no .env da instalação e reinicia a API. Depois confere em Configurações > Backup que 'Backup em outro disco' ficou PRONTO. Nenhuma linha de código falta.
- **GAP-PRD-083** (achado original: "Taxas/prazos de operadora não cadastrados no banco real: cartão liquida no mesmo dia pelo valor bruto") — **o que falta de fora:** Emanuel, com gerente e contador de cada uma das seis operações: em Financeiro > Operadoras de cartão, cadastrar a operadora e, por forma de pagamento e número de parcelas, a taxa (bps) e o prazo de repasse de cada contrato de maquininha.
- **GAP-PRD-112** (achado original: "Banco operacional sem nenhum produto serializado nem unidade: o dia 1 da PJ Motors exige marcar produtos como 'Controlado por unidade' e identificar chassis (sem código)") — **o que falta de fora:** Emanuel: marcar cada produto-moto da PJ Motors como Controlado por unidade; gravar o chassi de cada moto do pátio; vincular a plaquinha da Oficina a cada unidade; decidir o equipamento SOLD órfão da Oficina (manter, ou desfazer pela ficha com motivo). Não abri o banco da loja para confirmar o estado atual.
- **GAP-PRD-119** (achado original: "Rastreamento de transportadora inexistente: portal e ERP mostram só o código digitado; 'entregue' é clique do operador") — **o que falta de fora:** Para os eventos vindos do provedor: o token de produção do Melhor Envio + LOGISTICS_PRODUCTION_ENABLED=true (o mesmo do GAP-PRD-030/120). Transportadora, link e origem do 'entregue' já funcionam sem insumo no despacho manual.
- **GAP-PRD-120** (achado original: "Etiqueta e envio no provedor não existem; POST /logistics/shipments grava qualquer corpo como 'quoted'") — **o que falta de fora:** Token de produção do Melhor Envio com permissão de carrinho, compra, geração, impressão e rastreio (Loja → Logística). LOGISTICS_PRODUCTION_ENABLED=true. Saldo na carteira do Melhor Envio. Endereço do remetente completo em Fiscal → Configuração. NF-e autorizada de cada pedido, ou a decisão do contador para ligar a declaração de conteúdo. Agência Jadlog se usar serviço Jadlog. Nenhuma etiqueta real foi comprada: os endpoints só foram provados contra fetch dublado.
- **GAP-PRD-128** (achado original: "Caixa IMAP da Preço Justo cadastrada mas com autenticação falhando ('Command failed') desde 13/08 e leitura automática desligada") — **o que falta de fora:** Emanuel, na conta Google da caixa da Preço Justo: ativar a verificação em duas etapas, gerar uma senha de app e confirmar que o IMAP está ligado. Depois, colar a senha em Compras › NF-e por e-mail › Senha de aplicativo, clicar 'Testar conexão' e depois 'Ativar' na leitura automática.
- **GAP-PRD-129** (achado original: "Catálogo sem NCM/CFOP fora da Preço Justo (e 10 de 13 na própria PJ), sem grupo tributário e sem CFOP de venda configurado em nenhuma empresa") — **o que falta de fora:** Contador: classificar o catálogo das seis empresas (confirmar em lote as sugestões do XML e classificar o PENDENTE/DIVERGENTE) e informar o grupo tributário de cada empresa (CFOP interno e interestadual, origem, CSOSN/CST). CFOP de venda em Compras › Configuração é opcional.
- **GAP-PRD-130** (achado original: "E-mail transacional, contador e central vivem só no .env global (com reinício) e a fila já acumula; nenhuma empresa tem destinatário do contador nem usuário contador") — **o que falta de fora:** Emanuel: preencher no .env do servidor EMAIL_ENABLED=true, EMAIL_FROM, EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_USER e EMAIL_SMTP_PASSWORD (senha de app). Em cada empresa: cadastrar o e-mail do escritório em Fechamento do contador, ligar o envio automático (dia 1 a 28) e criar o usuário com perfil 'Escritório de contabilidade (externo)'. O contador fornece o e-mail e o login. DEVORA_BACKUP_DIR continua lido só no boot, mas é da frente DEP, fora deste lote.
- **GAP-PRD-151** (achado original: "Atalho sem senha ligado no .env desta máquina e usado 184 vezes contra o banco do dono; docker-compose.yml publica em 'development'") — **o que falta de fora:** Emanuel, no .env da instalação da loja: apagar DEVORA_DEV_QUICK_LOGIN (ou =false) e escrever DEVORA_API_ENV=production e NODE_ENV=production antes do go-live. Não abri esse .env.
- **GAP-PRD-154** (achado original: "Artefatos legados versionados: server/backups/*.json (snapshots JSON do projeto anterior) apesar de .gitignore listar a pasta; server/data/devora-api.json; .env.bak-* com segredos na raiz (ignorado)") — **o que falta de fora:** Na máquina da loja: guardar .env.bak-2026-08-27T13-42-14-753Z no cofre de senhas e apagá-lo da pasta; conferir e apagar server/data/devora-api.json e o que restar em server/backups/*.json. A conferência da implantação aponta cada um. Não abri a pasta da loja.
- **GAP-PRD-168** (achado original: "XML por e-mail (IMAP) e DF-e/manifestação dependem de insumos externos — o código está ligado") — **o que falta de fora:** Credencial IMAP por empresa (Compras › NF-e por e-mail); certificado A1 com a senha em Fiscal › Certificado; homologação da Distribuição DF-e e da manifestação no ambiente real da SEFAZ.

### Equipamento externo (3)

- **GAP-PRD-014** (achado original: "Maquininha/TEF: nenhum provedor real implementado — adapter 'estrutural' devolve failed, Local Agent não tem fila de comandos nem callback; configurar credencial real hoje deixa o balcão SEM cartão") — **o que falta de fora:** Por caixa: PinPad e o gerenciador TEF licenciado e homologado com a adquirente, configurado na troca de arquivos (pastas REQ/RESP); Node 22+ com server/dist no computador do caixa e o agente como serviço (parear/saude/rodar); a TEF house conferindo os campos IntPos; homologação com cartões reais pelo roteiro da tela.
- **GAP-PRD-082** (achado original: "Impressão silenciosa e gaveta por comando dependem de um agente local que não existe; ESC/POS é gerado sem consumidor") — **o que falta de fora:** Por balcão: impressora térmica ESC/POS (rede na porta 9100, USB compartilhada, serial ou paralela). No computador do caixa: Node 22+ com server/dist e o agente pareado em Configurações > Maquininhas > Agente local (--sem-tef se não houver PinPad), rodando como serviço (NSSM ou Agendador). Depois, cadastrar a impressora com caixa e endereço em Configurações > Impressoras e confirmar a página de teste. Com isso em mãos, nenhuma linha de código.
- **GAP-PRD-203** (achado original: "Impressora só na Preço Justo (navegador), terminal 'mock' cadastrado na PJ, TEF e impressão silenciosa dependem de hardware/agente") — **o que falta de fora:** Uma impressora de cupom por balcão nas seis operações, cadastrada em Configurações > Impressoras (térmica com agente local para cupom sem diálogo e gaveta por comando). Desligar a maquininha de teste (mock) da Preço Justo em Vendas > Conferência de maquininha. PinPad e cliente TEF homologados por caixa quando houver contrato: esse caminho depende do GAP-PRD-014, fora deste lote, e não o verifiquei a fundo aqui.

### Decisão do dono (12)

- **GAP-PRD-013** (achado original: "O repositório não serve o frontend nem traz proxy/host estático, HTTPS ou supervisor: hoje a instalação roda o Vite de desenvolvimento (3000) e a API (8787) à mão") — **o que falta de fora:** Emanuel escolhe a topologia. (a) Domínio público: DNS A, portas 80/443, caddy.exe e o Caddyfile com o domínio. (b) Só LAN: tls internal e a raiz do Caddy instalada nos PDVs. Depois preenche o .env de produção (DEVORA_SERVIR_FRONTEND=true, DEVORA_TRUST_PROXY=1, DEVORA_FRONTEND_ORIGIN), faz o build com VITE_API_BASE_URL=/ e roda instalar-servico.ps1 como administrador.
- **GAP-PRD-046** (achado original: "Fila offline é por navegador (localStorage): invisível ao gestor e a outros caixas; perde-se com a máquina do PDV") — **o que falta de fora:** Emanuel confirmar a opção (a): nobreak no servidor da loja e backup diário mantido. Ou pedir (b), que abre um projeto novo.
- **GAP-PRD-054** (achado original: "Alçada pontual: no banco real só existem DOIS autorizadores para as seis operações (admin_geral e gestor do grupo)") — **o que falta de fora:** Emanuel decide quem tem alçada em cada loja e cadastra gerente_loja ou gerente_oficina por operação em Usuários e equipe.
- **GAP-PRD-088** (achado original: "NF 9991 (Preço Justo, R$ 1.485,60) está RECEBIDA sem conta a pagar — precisa de decisão humana") — **o que falta de fora:** Emanuel decide a NF 9991 pela tela: lançar a conta, lançar já paga (com data e forma) ou declarar que ela não gera conta (com justificativa).
- **GAP-PRD-098** (achado original: "Contingência é só fundação: tpEmis não muda, sem DANFCE/dizeres de contingência, sem EPEC, entra após 5 tentativas (só se houver emissões) e sai só por rota sem botão") — **o que falta de fora:** Contador ou Emanuel: escolher AGUARDAR ou OFFLINE_NFCE e o prazo da UF em Fiscal > Documentos > Contingência da NFC-e. Depois, homologar na SVRS uma NFC-e offline com o A1 real. EPEC não foi feito (no RS a NFC-e usa a offline). Contingência SVC da NF-e 55 seria trabalho novo, fora desta ficha.
- **GAP-PRD-160** (achado original: "ERP sem 'esqueci minha senha' para funcionários: só a gestão redefine (senha provisória); o dono decide se isso basta") — **o que falta de fora:** Emanuel decide, por operação, se liga a recuperação por e-mail (em Usuários e equipe; o padrão é desligado, e desligado já é o modelo atual). Se ligar: configurar EMAIL_ENABLED, EMAIL_FROM, EMAIL_SMTP_HOST/USER/PASSWORD e cadastrar o e-mail de cada funcionário.
- **GAP-PRD-163** (achado original: "NFC-e não é emitida no Finalizar: é botão manual no painel fiscal pós-venda") — **o que falta de fora:** Emanuel: escolher MANUAL ou AUTOMATICA no cartão 'NFC-e no Finalizar' (Fiscal > Configuração).
- **GAP-PRD-165** (achado original: "Painel (faturamento, ticket, recebíveis em aberto) e posição de estoque com custo abertos a atendente e estoquista") — **o que falta de fora:** Emanuel confirma na tela se atendente e estoquista veem o dinheiro do painel e o custo do estoque (padrão: não veem).
- **GAP-PRD-166** (achado original: "Valor do estoque por custo do CADASTRO (último custo), não custo médio ponderado; CMV por custo fotografado") — **o que falta de fora:** O contador confirma a régua (último custo ou custo médio), e o dono a registra na tela com o nome dele.
- **GAP-PRD-171** (achado original: "Sete lançamentos quitados sem linha de baixa no banco real (anteriores ao V29): invisíveis à conciliação bancária") — **o que falta de fora:** Emanuel decide se cria as baixas-espelho dos lançamentos antigos. Se sim, é um clique com confirmação em Financeiro > Conciliação bancária. Se não, nada a fazer.
- **GAP-PRD-188** (achado original: "OS legada #1 no banco real fora das regras atuais (sem oficina, sem responsável, evento finalizada→em_andamento)") — **o que falta de fora:** Emanuel ou o gerente da oficina: abrir a OS #1 e escolher, pela tela, 'devolver ao quadro' ou 'encerrar como lançamento indevido', com motivo. Não abri o banco da loja para confirmar que a OS #1 ainda está lá; o gaps.json diz que nada foi aplicado.
- **GAP-PRD-198** (achado original: "POST /core/emails/enviar do gerente de uma empresa entrega a fila das seis; FROM único do ambiente sem remetente/assinatura por empresa") — **o que falta de fora:** Emanuel decide, empresa por empresa, na tela E-mails: remetente do grupo (padrão, já vale) ou da empresa. Endereço próprio só funciona se estiver cadastrado como 'Enviar como' no provedor SMTP.

## 6. Portões finais

| Portão | Resultado | Evidência |
| --- | --- | --- |
| Árvore limpa | PASSOU | HEAD 99d01b3e, git status vazio |
| Typecheck (tela, node e servidor) | PASSOU | npm run type-check exit 0 (58s) |
| Lint (tela e servidor, --max-warnings 0) | PASSOU | npm run lint exit 0 (54s) |
| Build (vite + tsc do servidor) | PASSOU | vite exit 0, 0 arquivo(s) .map, maior pedaço index-Bfcf0rol.js 427 kB; tsc do servidor exit 0 |
| Varredura de segredos (o que o git rastreia) | PASSOU | npm run secret:scan exit 0: > node server/node_modules/tsx/dist/cli.mjs server/src/scripts/varredura-de-segredos.ts / Varredura de segredos: limpa (700 arquivos rastreados conferidos). |
| Suíte do servidor (inteira) | PASSOU | Test Files  526 passed (526) · Tests  7159 passed \| 18 skipped (7177) (785s) |
| Suíte de tela (inteira) | PASSOU | Test Files  268 passed (268) · Tests  2527 passed (2527) (308s) |
| Instalação limpa (clone + npm ci offline + build + migrate + seed + boot) | PASSOU | clone ok; npm ci raiz ok; npm ci servidor ok; build ok; migrate ok; status EM_DIA; seed ok; API na porta 19651: /api/v1/health 200; banco: versão 85, 187 tabelas, integrity ok, FK 0 |
| Backup e restauração em banco temporário | PASSOU | backup exit 0, verificação exit 0, restauração exit 0; restaurado: 187 tabelas, 139 linhas, integrity ok, FK 0, tabelas com contagem diferente: nenhuma |
| Migração de um banco criado pelo código de dc48841 (versão 84) até a final | PASSOU | archive 0, junção 0, seed antigo 0 (versão 84, 258 tabelas); migração 0; status EM_DIA; depois: versão 85, 299 tabelas, integrity ok, FK 0; tabelas que perderam linhas: nenhuma — reexecutado isolado em 99d01b3e. A primeira tentativa, na rodada completa, FALHOU: o portão foi lançado do PowerShell e o `tar` do cano virou o do Windows (System32\tar.exe), que sem `-f -` tenta ler da fita (\\.\tape0); o git archive de dc48841 não extraiu e o seed antigo nem rodou. Conserto no script do portão (`tar -xf -`), ensaiado no mesmo ambiente (925 arquivos extraídos) — nenhum código do produto mudou. |
| Clone descartável do banco real (VACUUM INTO só-leitura) migrado até a final | PASSOU | antes: versão 84, 339 tabelas; migração 0; status EM_DIA; depois: versão 85, 380 tabelas, integrity ok, FK 0; contagens de negócio iguais: true |
| Falsificação de empresa (tenant) | PASSOU | 96 arquivos (a-oficina-assina-como-oficina.test.ts, a-rota-confere-o-que-o-corpo-manda.test.ts, adm-preso-a-sua-loja.test.ts, asaas-rotas-legadas.test.ts, audit-caixa.test.ts, audit-crm.test.ts, audit-fiscal.test.ts, audit-pjmotors.test.ts, audit-purchase.test.ts, audit-tenant.test.ts, audit-workshop.test.ts, auditoria-p0-isolamento.test.ts, auditoria-tem-leitor.test.ts, bi-grupo.test.ts, caixa-da-oficina.test.ts, cartao-tem-comprovante.test.ts, catalog-aux.test.ts, centro-de-custo-tem-leitor.test.ts, cobranca-do-titulo.test.ts, comissoes.test.ts, consignado-ciclo-real.test.ts, contador-envio-do-pacote.test.ts, contador-varredura-das-rotas.test.ts, core-api.test.ts, core-invariants.test.ts, credito-de-loja.test.ts, cupom-de-desconto.test.ts, desfazer-conciliacao-deixa-rastro.test.ts, devolucao-ao-fornecedor.test.ts, devolucao-serializada.test.ts, dfe-pela-politica-dos-atos.test.ts, documento-aberto-se-corrige.test.ts, email-reenvio-com-motivo.test.ts, empresa-nasce-inteira.test.ts, entrada-casamento-com-o-catalogo.test.ts, entrada-manual-sem-nota.test.ts, envio-etiqueta-rastreio.test.ts, equipamento-completo.test.ts, equipamento-no-estoque.test.ts, estorno-da-entrada.test.ts, fechamento-contador.test.ts, fila-sem-plaquinha.test.ts, fiscal-document.test.ts, fiscal-multiempresa.test.ts, fotos-em-lote.test.ts, gaveta-e-cupom-termico.test.ts, grupo-tributario-no-cadastro.test.ts, identidade-do-equipamento.test.ts, imap-senha-recusada-e-teste-de-conexao.test.ts, impressao-pelo-agente-local.test.ts, impressao.test.ts, inventario-por-local.test.ts, liberacao-pontual.test.ts, maquininha-estorno-e-comprovante-honestos.test.ts, nfse-da-mao-de-obra.test.ts, nota-recebida-sem-conta.test.ts, o-certificado-se-apresenta.test.ts, o-rastro-diz-quem-tirou-pelo-nome.test.ts, o-segredo-de-uma-empresa-nao-vaza-para-outra.test.ts, o-xml-classifica-o-produto.test.ts, oficina-avisa-o-cliente.test.ts, orcamento-prevenda.test.ts, os-de-verdade.test.ts, os-em-papel.test.ts, pacote-do-contador-dia-da-loja-e-integridade.test.ts, painel-por-operacao.test.ts, pedido-de-compra-vai-ao-fornecedor.test.ts, pedido-maquina-de-estados.test.ts, pendencias-eletronicas-da-maquininha.test.ts, plaquinha-cruzada-e-recusada.test.ts, portal-do-dono.test.ts, portal-pos-venda.test.ts, preco-por-faixa-de-quantidade.test.ts, product-clone.test.ts, produto-fotos.test.ts, produto-tipo.test.ts, promocao-edicao-horario-limite.test.ts, promocao-validada.test.ts, prompt15-integrations-asaas.test.ts, prompt26-audit-compliance.test.ts, quadro-com-versao.test.ts, quem-mexe-na-os.test.ts, rastro-de-item-cancelado.test.ts, regressions.test.ts, relancar-como-venda-nova.test.ts, reprecificacao.test.ts, reserva-sem-origem-tem-porta.test.ts, rodada-32-rotas-religadas.test.ts, rotas-fiscais-legadas-fora-do-ar.test.ts, sefaz-eventos-nfce-e-nfe.test.ts, session-switch.test.ts, titulo-e-origem-sao-navegaveis.test.ts, variantes.test.ts, vendas-offline-recusadas.test.ts, vendedor-no-balcao.test.ts, webhook-asaas-rota-registrada.test.ts): Test Files  96 passed (96) · Tests  1663 passed \| 1 skipped (1664) |
| Permissões e alcance por perfil | PASSOU | 7 arquivos (alcada-sem-porta-dos-fundos.test.ts, bi-e-painel-seguem-o-perfil-de-cada-operacao.test.ts, perfil-mora-na-conta.test.ts, permissions.test.ts, regra-rota-declara-alcance.test.ts, rodada-31-alcance-declarado.test.ts, seletor-de-perfil-so-oferece-o-que-se-pode-dar.test.ts): Test Files  7 passed (7) · Tests  79 passed (79) |
| Idempotência | PASSOU | 91 arquivos (a-rota-confere-o-que-o-corpo-manda.test.ts, a-unidade-fiscal-e-uma-so.test.ts, agente-local-impressora.test.ts, agente-local-programa.test.ts, alcada-sem-porta-dos-fundos.test.ts, asaas-rotas-legadas.test.ts, audit-caixa.test.ts, audit-crm.test.ts, audit-dashboard.test.ts, audit-ecommerce.test.ts, audit-finance.test.ts, audit-fiscal.test.ts, audit-impressao.test.ts, audit-pdv.test.ts, audit-reports.test.ts, audit-tenant.test.ts, auditoria-p0-isolamento.test.ts, baixa-com-idempotency-key.test.ts, banco-na-85-ganha-a-impressao-da-venda.test.ts, bi-decorativo-sai-do-ar.test.ts, caixa-da-oficina.test.ts, carrinho-da-conta.test.ts, cartao-tem-comprovante.test.ts, central-de-relatorios.test.ts, chave-derivada-pelo-servidor.test.ts, checkout-conta-entrega-no-endereco-salvo.test.ts, checkout-conta-entrega-recusa-antes-da-cotacao.test.ts, checkout-cpf-alheio-nao-sequestra.test.ts, checkout-exige-conta.test.ts, checkout-mesma-chave-outra-loja.test.ts, checkout-visitante-confere-dados.test.ts, clique-duplo-nao-entra-duas-vezes.test.ts, cmv-nasce-na-venda.test.ts, consignado-ciclo-real.test.ts, core-api.test.ts, crm-nucleo.test.ts, csc-por-ambiente.test.ts, cupom-de-desconto.test.ts, devolucao-devolve-o-que-entrou.test.ts, dinheiro-so-com-gaveta.test.ts, documento-vira-venda-sem-brecha.test.ts, ecommerce-core.test.ts, empresa-nova-sem-codigo.test.ts, enderecos-com-retrato.test.ts, envio-etiqueta-rastreio.test.ts, fatia-a-vista-nasce-com-baixa.test.ts, frete-de-cada-loja.test.ts, gaveta-e-cupom-termico.test.ts, impressao-pelo-agente-local.test.ts, logistics.test.ts, loja-frete-checkout.test.ts, maquininha-de-teste-fora-da-producao.test.ts, maquininha-pelo-agente-local.test.ts, maquininha-uma-cobranca-por-chave.test.ts, margem-do-bi-bate-com-o-dre.test.ts, melhor-envio-producao.test.ts, mesma-chave-outra-mercadoria.test.ts, mesma-chave-outro-corpo.test.ts, mesma-chave-outro-dinheiro.test.ts, moto-da-pre-venda.test.ts, municipios-do-ibge-no-faturamento.test.ts, municipios-do-ibge.test.ts, nfce-no-finalizar.test.ts, nfce.test.ts, o-legado-nao-inventa-estado.test.ts, o-legado-sem-consumidor-sai-do-ar.test.ts, os-na-central-e-no-cmv.test.ts, painel-por-operacao.test.ts, parcelamento-no-cartao.test.ts, payment-terminals.test.ts, peca-entra-na-gaveta.test.ts, pedido-online-nos-relatorios.test.ts, pendencias-eletronicas-da-maquininha.test.ts, politica-do-balcao.test.ts, preco-fixado-na-tabela.test.ts, prevenda-gasta-o-vale.test.ts, prompt17-logistics-enterprise.test.ts, prompt18-payment-terminals-enterprise.test.ts, rastro-de-item-cancelado.test.ts, relancar-como-venda-nova.test.ts, reserva-de-pedido-expira.test.ts, rodada-32-rotas-religadas.test.ts, rotas-fiscais-legadas-fora-do-ar.test.ts, session-switch.test.ts, tabela-de-preco-vale-na-venda.test.ts, terminais-e-gaveta-por-caixa.test.ts, terminal-sem-cadastro.test.ts, titulo-e-origem-sao-navegaveis.test.ts, uma-grafia-so-para-a-marca.test.ts, vendas-offline-recusadas.test.ts, vendas-por-marca.test.ts): Test Files  91 passed (91) · Tests  1271 passed \| 4 skipped (1275) |
| Concorrência | PASSOU | 25 arquivos (alcada-sem-porta-dos-fundos.test.ts, crm-nucleo.test.ts, desconto-negativo-nao-e-acrescimo.test.ts, desfazer-conciliacao-deixa-rastro.test.ts, dfe-cursor-da-sefaz.test.ts, equipamento-completo.test.ts, equipamento-no-estoque.test.ts, estoque-serializado.test.ts, fechamento-contador.test.ts, fiscal-events.test.ts, fiscal-multiempresa.test.ts, logistica-operacao.test.ts, plaquinhas-pool.test.ts, politica-do-balcao.test.ts, produto-tipo.test.ts, produtos-sem-envio.test.ts, promocao-edicao-horario-limite.test.ts, promocao-vigencia.test.ts, prontidao-online.test.ts, recuperacao-de-senha-com-teto.test.ts, remetente-por-empresa.test.ts, schema-drift.test.ts, sync-worker.test.ts, uma-instancia-por-banco.test.ts, vendas-por-marca.test.ts): Test Files  25 passed (25) · Tests  568 passed (568) |
| Banco operacional intocado durante os portões | PASSOU | api_request_logs 5679 → 5679; core_schema_version 84 → 84 |
| Banco operacional intocado durante os portões (reexecução isolada) | PASSOU | api_request_logs 5679 → 5679; core_schema_version 84 → 84 |
| E2E de API na pilha descartável — no HEAD final 99d01b3 | PASSOU | 94 verificações PASS, 0 FAIL, 0 observações; 140 requisições, todas para http://localhost:19591. A.15 (access depois do logout) e E.5 (mesma chave, outra mercadoria), que eram observações em 1078ddb, agora são verificações. |

## 7. Walkthrough de API e navegador

HEAD `99d01b3`: 94 verificações passaram, 0 falharam, 0 observações; 140 requisições, todas para http://localhost:19591 (pilha descartável, banco temporário semeado).

- a. login, troca da senha provisória, sessão, refresh com rotação, logout (o access de antes cai: 401 API_SESSION_ENDED); a troca de operação exige a prova da sessão (sem o refresh: 401 API_SESSION_PROOF_REQUIRED) e encerra o access e o refresh de antes
- b. dia de venda completo: produto, entrada, caixa, venda em dinheiro, estoque e financeiro, fechamento com diferença zero
- c. falsificação de empresa: tentativas de ler, escrever e trocar para outra empresa, todas recusadas (404/403/400)
- d. permissões: PDV nas rotas de gestão, 403
- e. idempotência: reenvio, paralelo, baixa e movimento com a mesma chave, um registro; a mesma chave com outra mercadoria é recusada (422 CORE_IDEMPOTENCY_KEY_REUSED), sem venda nova e com o estoque intacto
- f. concorrência: duas e cinco vendas da última unidade, estoque nunca negativo
- g. oficina: OS, etapas, página pública do QR sem vazamento

**As duas observações do walkthrough:**

- A.15 — antes (1078ddb): depois do logout o access token valia até expirar (3600 s). Reclassificada como BUG de segurança (ASVS 3.3.1: sair encerra a sessão no servidor), não como modelo aceito: corrigida em 598c0cd (jti revogado) e completada em 5efcde8/ff0c7b9 (família de sessão: troca de operação, rotação e logout com corpo velho não deixam credencial viva). Agora é verificação PASS: o token de antes do logout toma 401 API_SESSION_ENDED.
- E.5 — antes (1078ddb): a mesma Idempotency-Key com outra mercadoria devolvia a venda original (200). Reclassificada como BUG de contrato (INCONSISTENT_CONTRACT; o rascunho IETF de Idempotency-Key pede 422), não como endurecimento opcional: corrigida em d622b6d e estendida aos vizinhos em 33234ef/ea167e5 (o dinheiro entra na impressão). Agora é verificação PASS: 422 CORE_IDEMPOTENCY_KEY_REUSED, nenhuma venda nova, estoque intacto.

**Navegador:**

- Em 1078ddb (não repetido no HEAD final): loja pública nas pilhas descartáveis (Vite e build servido pela API) — lojas carregam, zero violação de CSP numa aba nova; login, /pdv sem sessão vai ao login, páginas legais.
- Não verificado em navegador real: as telas com sessão (exigiria digitar senha no navegador, o que esta missão não faz) e o registro do service worker (o navegador embutido não registra SW nem no Vite de desenvolvimento). Essas telas estão cobertas pela suíte de tela (268 arquivos, 2527 testes no HEAD final) e a API delas pelo E2E.
- Depois de 1078ddb a CSP das telas servidas pela API mudou (8bf6e68: só o que sai como tela troca a política) — provado pela suíte do servidor (as-telas-servidas-pela-api-carregam 29/29), não em navegador.

## 8. Achados da integração, fora das 210 fichas

| Commit | Achado | O que mudou |
| --- | --- | --- |
| `db0ae4a` | Byte NUL cru no StorefrontService (junção da ECO) e trava para o repositório inteiro | O git tratava o arquivo como binário: sem diff e a junção virava um conflito do arquivo inteiro. Agora os fontes são texto, com a trava os-fontes-sao-texto. |
| `d5b8e61` | A tela servida pela API herdava a CSP da API e abria em branco | Com DEVORA_SERVIR_FRONTEND=true, default-src none bloqueava o próprio pacote e o precache do service worker. Provado no navegador: zero violação de CSP depois do conserto. |
| `5a739b6` | Build com o "/" reescrito pelo Git Bash | A loja publicada pedia os dados a file:///C:/Program Files/Git/. O build agora recusa, com o conserto escrito. |
| `7b9b205` | /sistema caía em "Esta loja não existe" | O endereço da gestão abre o painel (sem sessão, o login). |
| `4a7da58` | Empresa nova podia ganhar rota do sistema como endereço de loja (/pdv, /login, /loja) | Os slugs reservados cobrem toda rota fixa de um segmento, com trava que confere contra o roteador. |
| `73dcd05` | POST /core/equipment devolvia o token do QR | Tirado, como nas outras rotas de equipamento. |
| `44f3ca7` | Teste do desligamento com prazo instável sob carga | Espera a requisição presa chegar em vez de dormir 50 ms. |
| `598c0cd (junção 481cd24)` | Observação A.15 do walkthrough, reclassificada como BUG de segurança (ASVS 3.3.1): depois do logout o access token valia até expirar (1 h) | Todo access token ganha jti (não secreto); o logout grava o jti em core_tokens_revogados (DDL canônica, sem passo novo) e conferirContaDaSessao recusa com 401 API_SESSION_ENDED, numa consulta por chave primária preparada por conexão. Token sem jti (anterior) aceito até o exp. server/tests/logout-encerra-o-token-de-acesso.test.ts 8/8, vermelho 8/8 no código de 1078ddb; verificador adversarial reproduziu o vermelho e não achou defeito. |
| `d622b6d (junção 2c59d18)` | Observação E.5 do walkthrough, reclassificada como BUG de contrato (INCONSISTENT_CONTRACT): a mesma Idempotency-Key com outra mercadoria devolvia a venda original (200) | core_sales.idempotency_fingerprint (anulável, DDL + reconcile): SHA-256 versionado do JSON canônico da mercadoria; divergência recusada com 422 CORE_IDEMPOTENCY_KEY_REUSED antes de escrever; venda antiga sem impressão segue a regra de antes. server/tests/mesma-chave-outra-mercadoria.test.ts 13/13 e documento-vira-venda-sem-brecha ajustado; verificador adversarial tentou reenvios legítimos (ordem, tipos, kit, OS, consignação, PIX, maquininha, offline) e todos seguem 200. |
| `5efcde8, ff0c7b9, 3cec714, ecdfe75 (junção eb0f4fc)` | Resíduo do logout (verificador de 598c0cd): a troca de operação, a rotação do refresh e o logout com corpo velho deixavam credencial viva por até 7 dias | Família de sessão (sid não secreto no JWT e no registro do refresh): login abre família, rotação e troca a mantêm; a rotação revoga o access anterior; troca e logout revogam todos os refresh vivos da família e o jti de quem chamou; a poda periódica leva os jtis vencidos. O cliente manda no logout o refresh de agora e não repete requisição em outra operação; a venda da fila offline guarda a operação em que foi feita e só sobe nela (dois defeitos achados e corrigidos pelo verificador). sair-encerra-a-familia-da-sessao 13 casos (11 vermelhos antes), logoutLevaORefreshAtual 3 (3 vermelhos); suíte do servidor 506/507 (a falha é carga, 5/5 isolado) e de tela 256/256. |
| `9dcd8ea, 71fc3e9, 8e46c01, 8a0a752, 25f4b09 (junção 51e46d9)` | Resíduo da chave reusada (verificador de d622b6d): o PDV e a regularização offline não sabiam o que fazer com o 422 | O PDV diz na língua do caixa que a tentativa já registrou a venda #N e oferece, por escolha, registrar como venda nova (chave nova); a regularização offline relança como venda nova (rota nova, mesma permissão do relançamento, idempotente); o F8 por reflexo não finaliza por baixo dos diálogos (defeitos achados pelo verificador); teste permanente do banco da loja na versão 85 ganhando a coluna pela subida real. Servidor 508/508 arquivos, tela 257/257. |
| `ea167e5, 33234ef, 38ba022, 085feac (junção 5c76738)` | Resíduo da chave reusada nos vizinhos da venda: consignação, movimento de estoque, PIX do balcão, maquininha, recebimento da OS, entrada manual, peças, envio ao contador, logística e o withIdempotency genérico devolviam o resultado antigo com outro corpo | Mapa de todos os consumidores de chave do cliente (no commit); impressão digital versionada em cada um e 422 CORE_IDEMPOTENCY_KEY_REUSED antes de escrever; a baixa passa de 409 para 422 com o mesmo código; a venda passa a incluir o dinheiro (pagamentos, desconto, acréscimo, crédito) na impressão, porque nenhum reenvio legítimo muda o dinheiro (conferido fluxo a fluxo). Suíte do servidor 506/508 com as duas falhas consertadas pelo verificador (38ba022, 085feac). |
| `77d0bb7` | Integração dos resíduos (5c76738): "registrar como venda nova" aceitava a MESMA mercadoria e vendia o atendimento duas vezes | Defeito de junção (cada branch verde sozinha): a comparação do relançamento como venda nova tirava a impressão só dos itens, e a gravada passou a levar o dinheiro (ea167e5). Passa a usar a mesma impressão da entrega. relancar-como-venda-nova 11/11 (o caso vermelho volta a 409), vizinhos verdes. |
| `8bf6e68` | O 404 de arquivo do build, o mapa de fonte recusado e o POST num caminho de tela saíam com a CSP das telas (mais frouxa) em vez da CSP da API | Achado pelo teste que a sessão paralela do dono escreveu (branch fix/csp-das-telas), rodado contra int/b: 27/29. A troca da política passa a acontecer só no arquivo que sai como tela (setHeaders do express.static, inclusive o 304) e no fallback do index.html; o teste do dono entra em int/b como trava, 29/29. |
| `d0a88cb, b5532bb, 77c28f4, 35183db (junção bfb7c04)` | Rodada 2 da sessão: a troca de operação transformava um access furtado (1 h) em refresh (7 dias); uma aba apagava a sessão da vizinha; o logout com access vencido não chegava ao servidor | POST /auth/switch-company exige a prova da sessão (o refresh atual, da mesma pessoa e da mesma família; troca para a mesma operação recusada); POST /auth/logout aceita encerrar a família só pelo refresh quando não há access válido (limite próprio de taxa); o cliente divide a sessão entre abas (evento storage, Web Locks com desistência, marca de renovação sem Web Locks — esta achada e corrigida pelo verificador). a-troca-exige-a-prova-da-sessao 17 casos (13 vermelhos antes), duasAbasDividemASessao 15 (11 vermelhos antes); suíte do servidor 514/515 (zip-writer, carga conhecida) e de tela 262/262. |
| `6d777c4, 587eca9, 7690daf, 41baa36, e6ea284, c902e59 (junção 1b4c025)` | Rodada 2 da idempotência: chaves que o servidor deriva podiam vir do cliente; telas ficavam presas depois do 422; a chave do checkout não cobria o carrinho inteiro | POST /sales e a entrega offline recusam chaves com a forma das do servidor (400 CORE_IDEMPOTENCY_KEY_RESERVED); movimentação de estoque, entrada manual, recebimento da OS e a pré-venda dizem na língua de quem opera que a tentativa já registrou outro lançamento e oferecem chave nova por escolha; o checkout grava a impressão do pedido inteiro (todas as lojas) e recusa outro carrinho com 422 antes de reservar, devolvendo todos os pedidos da primeira vez no mesmo corpo; o relançamento offline sem gaveta provado como correto (a gaveta do dinheiro nunca é nula quando a operação trabalha com gaveta). Verificador: suíte do servidor 516/517 (zip-writer isolado 6/6), tela 263/263. |

## 9. Banco operacional (só leitura)

| Conferência | Linha de base | Agora |
| --- | --- | --- |
| PRAGMA integrity_check | ok | ok |
| PRAGMA foreign_key_check (linhas) | 0 | 0 |
| core_schema_version | 84 | 84 |
| Tabelas | 339 | 339 |
| api_request_logs (linhas / maior seq) | 5722 / 5722 | 5679 / 5725 |
| Contagem das 337 tabelas de negócio (2026-09-13T01:12Z × 2026-09-13T10:36Z) | foto do meio da retomada | iguais, tabela a tabela |

- Leitura exclusivamente com `new DatabaseSync(caminho, { readOnly: true })`; nenhuma migração, nenhum teste e nenhuma requisição contra o banco ou a API do dono (porta 8787).
- Linhas de api_request_logs depois da linha de base da missão (seq > 5722): GET /favicon.ico → 404 às 2026-09-13T00:15:32.670Z; GET / → 404 às 2026-09-13T00:15:32.508Z; HEAD / → 404 às 2026-09-13T00:15:32.489Z — nenhuma veio da missão (seção 10).
- A contagem de api_request_logs caiu de 5722 para 5679 (menor seq agora 47): a poda de 30 dias da própria API do dono apagou as linhas mais antigas; o maior seq só cresceu pelas linhas acima.

## 10. Sessões paralelas

- 2026-09-12T01:12:32Z (22:12 em Pelotas): 10 linhas novas em api_request_logs do banco da loja (5712 → 5722), GETs sem token (401) em /core/purchases/notes, /purchases/dfe, /purchases/cte, /workshops e /workshop/parts, cada uma duas vezes, em ordem de montagem de tela. Nenhum processo da missão tinha navegador, vite dev/preview ou chamada à 8787; a suíte de tela das worktrees bloqueia fetch real (GAP-PRD-135). A sessão paralela interativa aberta às 22:10 negou ter chamado a 8787/3000. Origem não provada; o padrão (dupla chamada do StrictMode, sessão vencida) é o do frontend de desenvolvimento do dono na tela de Entrada de notas. Essa rajada é a linha de base da missão (5722).
- Com a sessão pausada pelo limite de créditos, 3 requisições à raiz (404) entraram no api_request_logs do banco da loja por volta de 2026-09-13T00h UTC. Nenhum processo da missão estava no ar; origem não atribuída (a API do dono segue ouvindo na 8787).
- api_request_logs caiu de 5722 para menos linhas durante a missão: é a poda de 30 dias que a própria API do dono aplica (política de retenção), não escrita da missão. As tabelas de negócio e core_schema_version (84) ficaram iguais à linha de base.
- O dono abriu em paralelo duas tarefas em sessões separadas: "Stop API CSP from blanking the served frontend" (o mesmo defeito que a integração já corrigiu em d5b8e61, na seção 8) e "Fix promotion tests failing since lote E5". Elas trabalharam fora de devora-int-b e nenhum commit delas foi juntado a int/b. A única coisa delas que entrou foi o TESTE de fix/csp-das-telas, copiado para int/b como trava depois de rodado contra int/b (8bf6e68, seção 8); ele achou 2 casos que int/b ainda não cumpria, corrigidos no mesmo commit.
- Branches das sessões paralelas do dono, conferidas no fim: rem/eco tem 2 commits de teste (6bade8b, bbe9389, 2026-09-11 22:27, a tarefa "Fix promotion tests failing since lote E5") que int/b já contém em conteúdo equivalente (o teste do cupom difere só no texto do comentário; o da promoção é idêntico) — nada a integrar. fix/csp-das-telas (c53970b, a tarefa "Stop API CSP from blanking the served frontend") conserta o mesmo defeito que int/b corrigiu em d5b8e61, sobre uma base mais antiga: juntar esse commit enfraqueceria a recusa dos mapas de fonte de int/b (ele volta a olhar só o último pedaço do caminho); o teste dele foi rodado contra int/b como prova (ver seção 8).
- 2026-09-13 04:39 (-03): durante a verificação da rodada 2 da sessão, OUTRA sessão comitou be9da65 dentro da worktree da missão devora-int-r2-sessao — provavelmente a tarefa em segundo plano que o engenheiro daquele item abriu para a venda em dobro que ele achou fora do seu escopo. O commit declara que traz idêntico o conserto 77d0bb7 de int/b (a impressão de agora leva o dinheiro) e acrescenta uma asserção ao teste (a lista não oferece venda nova para a pendência cuja própria venda já subiu). Foi integrado na junção de int/r2-sessao; não mexeu fora de VendasOfflineRecusadas.ts e do teste dela, nem na árvore do dono.

## 11. A pergunta final

> Se Emanuel fornecer agora todas as credenciais, certificados, dados empresariais, informações do contador e equipamentos externos ainda pendentes, o DEVORA precisará de MAIS PROGRAMAÇÃO antes do go-live?

**NÃO.**

- As 210 fichas têm status final dentro da lista permitida; OPEN = 0; nenhuma ficha de BUG, MISSING_IMPLEMENTATION, PARTIAL_IMPLEMENTATION, INCONSISTENT_CONTRACT, SECURITY_RISK, DATA_INTEGRITY_RISK, DEPLOYMENT_RISK ou UX_OPERATIONAL_RISK ainda pede código (seção 3).
- A reauditoria independente (um auditor por lote e contraprova para cada ficha contestável) confirmou 206 das 210. As 4 parciais foram resolvidas: GAP-PRD-153, 028 e 168 corrigidas com teste vermelho primeiro e verificador adversarial, e os resíduos que cada verificador achou fechados em três rodadas seguintes (DF-e por ambiente e pelo ultNSU da SEFAZ, NF-e de homologação fora da produção, município do IBGE pelo nome da cidade e conferido antes de numerar); GAP-PRD-188 é a decisão do dono sobre um dado (a OS #1), pela tela que já existe.
- Cada dependência externa da seção 5 responde "falta código? NÃO": a entrada de cada uma é uma tela, um arquivo ou um comando que já existem e estão testados (com dublês, sem chamada real).
- As duas observações do walkthrough (access depois do logout; mesma chave com outro corpo) eram defeitos: foram corrigidas, estendidas aos vizinhos e hoje são verificações PASS. O E2E final no HEAD 99d01b3 passou 94/94.
- Portões finais no HEAD 99d01b3: 18/18 — typecheck, lint, build, segredos, suíte do servidor (526 arquivos, 7159 testes), suíte de tela (268 arquivos, 2527 testes), instalação limpa, backup e restauração, migração de um banco da versão 84, clone do banco real migrado, tenant, permissões, idempotência, concorrência, banco da loja intocado e o E2E. O portão de upgrade foi reexecutado isolado depois de consertar o ambiente do portão (não o produto); a seção 6 diz isso.
- O banco da loja foi lido só em modo leitura e está preservado (seção 9).
- Limite dito com todas as letras: a prova com os provedores de verdade (SEFAZ em homologação, Asaas, SMTP/IMAP, Google, Melhor Envio, TEF/PinPad, impressora) só existe depois que Emanuel fornecer o insumo — o código de cada integração está pronto e testado contra dublês, e o que a homologação real mostrar é configuração ou resposta do provedor. As telas com sessão não foram vistas em navegador real nesta missão (exigiria digitar senha); estão cobertas pela suíte de tela e a API delas pelo E2E.

## 12. As 210 fichas

### GAP-PRD-001 — Banco REAL da Preço Justo tem configuração de maquininha 'mock' ATIVA: em produção o cartão trava (403) e fora de produção o mock APROVA sem dinheiro; não existe rota nem tela para desativar

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / DATA_INTEGRITY_RISK |
| Empresa / frente | Preço Justo / PAG |
| ANTES | Linha mock ativa na Preço Justo, sem rota nem tela para desligar. Em produção o cartão travava (403); em development o mock aprovava sem dinheiro. |
| Causa | A trava do mock (assertMockProviderAllowed) olhava so DEVORA_API_ENV e so nas portas de escrita/cobranca; a leitura que liga a exigencia de cobranca no balcao (getTerminalStatus) usava a forma sanitizada sem `active` e nunca consultava o ambiente; nao havia rota nem tela para desligar uma configuracao. |
| Correção | ambienteQueBloqueiaOMock()/mockProviderBlocked() com a regua dos dois nomes (production/staging ou NODE_ENV=production) usada por assertMockProviderAllowed; sanitizador passa a devolver active/simulated/desativacao; getTerminalStatus le a linha crua, ignora configuracao inativa e ignora o mock em ambiente de dinheiro (balcao volta ao cartao lancado a mao, mensagem nomeia a de teste ignorada) e declara `simulated` em dev/teste; setPaymentTerminalConfigurationActiveBackend (motivo obrigatorio, 404 entre empresas, 409 se ja no estado, trava do mock so ao religar, historico + auditoria) exposto em GET /core/pdv/terminal/configurations e POST /core/pdv/terminal/configurations/:id/deactivate\|activate (gerente_loja/gerente_oficina); testPaymentTerminalConnection e providers-status nao tratam o mock como utilizavel em producao; confirmarPixDeTeste confere o provider da cobranca e a trava; evaluateCoreProductionReadiness lista testTerminalConfigurations e vira NOT_READY com bloqueio critico nomeando a operacao; tela: card Maquininhas integradas na Conferencia de maquininha (estado, selo TESTE, aviso, Desligar/Religar com motivo) e aviso de maquininha de teste no PagamentoDialog antes de cobrar. Correcao do dado real descrita (SQL idempotente validado em SQLite de rascunho em memoria) em docs/audits/remediacao/migracoes/PAG.md, sem tocar o banco real. |
| DEPOIS | getTerminalStatus lê a linha crua, ignora configuração desligada e ignora o mock quando DEVORA_API_ENV é production/staging ou NODE_ENV=production; o balcão volta ao cartão manual com mensagem nomeando a de teste. O gerente desliga e religa com motivo, cerca por empresa (404), histórico e auditoria. A prontidão fica NOT_READY com bloqueio crítico enquanto houver mock ligado. Tela: card na Conferência de maquininha e aviso de teste no PagamentoDialog antes de cobrar. A linha real continua gravada até alguém desligá-la; isso é operação, não código. |
| Arquivos | server/src/services/payment-terminal/PaymentTerminalCredentialService.ts, server/src/services/payment-terminal/PaymentTerminalProviderAdapter.ts, server/src/services/payment-terminal/PaymentTerminalService.ts, server/src/services/core/PdvTerminalService.ts, server/src/services/system-admin/CoreProductionReadinessService.ts, server/src/routes/v1/core.ts, server/tests/maquininha-de-teste-fora-da-producao.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/MaquininhasIntegradasCard.tsx, src/lib/api/maquininhas.ts, src/pages/gs/ConferenciaMaquininhaPage.tsx, src/components/gs/PagamentoDialog.tsx, src/lib/api/core.ts, src/components/gs/__tests__/maquininhasIntegradas.test.tsx, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | 25fce09, dd7b186 |
| TESTES | server/tests/maquininha-de-teste-fora-da-producao.test.ts: NODE_ENV=production recusa o mock nas três portas; a linha mock gravada não liga a maquininha em produção; caixa não desliga (403); motivo obrigatório; outra empresa 404; em produção o gerente desliga e fica na auditoria; religar mock em produção recusado; prontidão com bloqueio que some depois de desligar. src/components/gs/__tests__/maquininhasIntegradas.test.tsx: desligar manda o motivo para /core/pdv/terminal/configurations/ptcfg-1786588515956/deactivate; aviso de teste em destaque. Rodados: verdes. |
| EVIDÊNCIA | server/src/services/payment-terminal/PaymentTerminalCredentialService.ts:27-72 (trava pelos dois nomes); server/src/services/core/PdvTerminalService.ts:197-247 (ignora inativa e mock bloqueado), :313-341; server/src/services/payment-terminal/PaymentTerminalService.ts:338-429 (liga/desliga: motivo, 404, 409, trava do mock só ao religar, histórico, recordAudit), :110-114 (painel de provedores); server/src/routes/v1/core.ts:4839-4883 (GET/POST configurations deactivate/activate, requireProfile gerente_loja/gerente_oficina); server/src/services/system-admin/CoreProductionReadinessService.ts:194-219 (bloqueio crítico); src/components/gs/MaquininhasIntegradasCard.tsx montado em src/pages/gs/ConferenciaMaquininhaPage.tsx:134; src/components/gs/PagamentoDialog.tsx:1269-1278 (aviso antes de cobrar). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Emanuel ou o gerente da Preço Justo precisa desligar a linha ptcfg-1786588515956 (Vendas > Conferência de maquininha > Desligar, com motivo), ou o integrador roda o SQL de docs/audits/remediacao/migracoes/PAG.md. A instalação de go-live precisa subir com DEVORA_API_ENV=production (ou NODE_ENV=production). Hoje a loja roda como development, e ali o mock opera por desenho, com o aviso na tela. |

### GAP-PRD-002 — Webhook registrado no Asaas é a rota legada inerte /api/v1/webhooks/asaas — eventos reais chegam e nada é baixado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas (hoje Preço Justo, única com chave); qualquer empresa que siga o checklist/OpenAPI / INT |
| ANTES | POST /api/v1/webhooks/asaas (a URL cadastrada no painel) só gravava em asaas_webhook_events e devolvia 200. Nada era baixado, e nenhuma tela nem documento dizia qual URL cadastrar. |
| Causa | duas rotas de webhook com processamentos diferentes; a registrada no painel (legada) nunca chegava ao nucleo financeiro, e nenhuma tela dizia a URL certa |
| Correção | POST /api/v1/webhooks/asaas delega a handlePaymentWebhook (empresa pelo token, tenant, idempotencia, resposta com ok/duplicate para compatibilidade); core_payment_webhooks.company_id (anulavel, DDL canonica) gravado com a empresa provada; servico AsaasWebhookInfo.describeAsaasWebhook (URL por operacao a partir de ASAAS_WEBHOOK_PUBLIC_URL ou GRUPO_SAMPAIO_PUBLIC_URL, URL antiga, alcancavel por HTTPS publico, ultimo aviso, contagem 30 dias, pendentes com erro) no GET /core/integrations/asaas; card WebhookAsaasCard na IntegracaoAsaasPage (copiar URL, alerta de endereco local, passo a passo, ultimo aviso, token do ambiente, URL antiga); OpenAPI com a rota por operacao e a antiga descrita; GO_LIVE_CHECKLIST diz qual URL cadastrar |
| DEPOIS | A rota antiga agora chama handlePaymentWebhook: a empresa sai do token do cofre, com o mesmo cerco de tenant e a mesma idempotência da rota por operação. O GET /core/integrations/asaas devolve a URL por operação, a URL antiga, se é alcançável e o último aviso; o card WebhookAsaasCard mostra isso na IntegracaoAsaasPage. OpenAPI e GO_LIVE_CHECKLIST dizem qual URL cadastrar. |
| Arquivos | server/src/routes/v1/index.ts, server/src/services/core/PaymentService.ts, server/src/services/core/AsaasWebhookInfo.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, server/src/openapi/spec.ts, server/src/routes/v1/storefront.ts, src/components/gs/WebhookAsaasCard.tsx, src/lib/api/asaasWebhook.ts, src/lib/api/core.ts, src/pages/gs/IntegracaoAsaasPage.tsx, docs/GO_LIVE_CHECKLIST.md, docs/audits/remediacao/migracoes/FIN.md, server/tests/webhook-asaas-rota-registrada.test.ts, src/pages/gs/__tests__/integracaoAsaasWebhook.test.tsx |
| COMMIT | 3161eba, 02abad1, 66769ce |
| TESTES | server/tests/webhook-asaas-rota-registrada.test.ts: PAYMENT_RECEIVED na rota antiga baixa o título (settled 30000, 1 baixa, core_payment_webhooks.company_id = gringa); marca o pedido como pago; token da Gringa contra título do Preço Justo dá 403; evento repetido dá duplicate e 1 baixa só; token errado 401, sem token 503; GET /core/integrations/asaas traz url/legacyUrl/lastEvent e um aviso sobre GRUPO_SAMPAIO_PUBLIC_URL; OpenAPI anuncia a rota por operação. src/pages/gs/__tests__/integracaoAsaasWebhook.test.tsx: a tela mostra e copia a URL e alerta endereço local. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/index.ts:392-403 (delega a handlePaymentWebhook); server/src/services/core/PaymentService.ts:1462-1471 (empresa pelo token), 1586-1601 (403 para outra operação); server/src/services/core/AsaasWebhookInfo.ts:93-150; server/src/routes/v1/core.ts:13770; src/pages/gs/IntegracaoAsaasPage.tsx:165 (WebhookAsaasCard); server/src/openapi/spec.ts:178-206; docs/GO_LIVE_CHECKLIST.md:116-128 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Configurar GRUPO_SAMPAIO_PUBLIC_URL (ou ASAAS_WEBHOOK_PUBLIC_URL) com o HTTPS público da API. Em cada operação: salvar o token do webhook na tela e cadastrar no painel do Asaas a URL que o card mostra. A URL antiga também passou a funcionar. |

### GAP-PRD-003 — Assinatura XMLDSig não canônica: digest sobre fragmento sem espaços e sem xmlns herdado, XML transmitido com caracteres de edição entre tags

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas as seis / FIS |
| ANTES | O digest era calculado sobre uma cópia sem espaços e sem o xmlns herdado. O XML transmitido saía indentado, com a Signature inserida nele. |
| Causa | Canonicalizacao caseira (regex) em vez de C14N; digest calculado sobre uma copia compactada enquanto o XML transmitido seguia indentado — a assinatura nunca era do que viajava. |
| Correção | FiscalSigner reescrito sobre xml-crypto 6.1.2: compactacao em arvore antes de assinar (FiscalXmlForma, com a libxml2 como juiz estrito da boa formacao), C14N 1.0 real do elemento com Id (xmlns herdado, atributos ordenados, texto preservado), SignedInfo com o perfil do leiaute (C14N, RSA-SHA1, SHA-1, enveloped + c14n), Signature sem prefixo como ultima filha do pai; mesmo motor para infNFe, infEvento e infInut; verificador com digest e SignedInfo em C14N, checkSignature completo e conferencia de que a Reference aponta para o Id do alvo; o pipeline faz autoconferencia do XML assinado (assinatura + XSD com a assinatura real) antes da fila e vai para ERROR com o motivo se falhar; o SIGNED registra signer e c14n. Dependencias (versao exata): xml-crypto 6.1.2 (XMLDSig/C14N, MIT) — a biblioteca madura que a ficha pede; @xmldom/xmldom 0.8.15 (a arvore que a xml-crypto usa, fixada na mesma versao para nao haver dois DOMs); libxml2-wasm 0.7.2 (boa formacao estrita, oraculo C14N independente nos testes e validador XSD do GAP-PRD-097). |
| DEPOIS | O XML é compactado pela árvore antes de assinar. A xml-crypto 6.1.2 faz C14N 1.0 real do elemento com Id. O XML devolvido, gravado e transmitido é o mesmo que foi resumido. O envelope só tira a declaração <?xml?>. O pipeline confere a assinatura antes de pôr na fila. |
| Arquivos | server/src/services/core/FiscalSigner.ts, server/src/services/core/FiscalXmlForma.ts, server/src/services/core/FiscalPipelineService.ts, server/package.json, server/package-lock.json, server/tests/fiscal-assinatura-c14n.test.ts, server/tests/fiscal-autoconferencia-da-assinatura.test.ts, server/tests/fiscal-signer.test.ts |
| COMMIT | cee7578, 5451630 |
| TESTES | server/tests/fiscal-assinatura-c14n.test.ts: sem espaço entre tags; C14N do infNFe com xmlns herdado e atributos em ordem; DigestValue igual ao SHA-1 da C14N da libxml2 e diferente do fragmento antigo; digest confere sobre a NFe tirada do enviNFe; SignedInfo confere por fora; evento e inutilização idem; XSD. Também fiscal-autoconferencia-da-assinatura e fiscal-signer. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/FiscalSigner.ts:153-211 (compactarXmlFiscal na l.158; C14N/RSA-SHA1 pela xml-crypto nas l.174-190; o XML devolvido é o assinado, l.202-206); server/src/services/core/FiscalXmlForma.ts:117-129; server/src/services/core/SefazRealAdapter.ts:228-243; server/src/services/core/FiscalPipelineService.ts:276-287 (autoconferência); server/package.json (xml-crypto 6.1.2, @xmldom/xmldom 0.8.15, libxml2-wasm 0.7.2; versão instalada 6.1.2 conferida). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A aceitação final é da SEFAZ: Emanuel precisa homologar na SVRS com o A1 real. Nenhuma linha de código depende disso. |

### GAP-PRD-004 — parseSefazResponse não reconhece <infProt Id="...">: autorização real vira REJECTED com o cStat do lote (104)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / BUG |
| Empresa / frente | Todas as seis / FIS |
| ANTES | A regex de infProt exigia a tag sem atributo. Com <infProt Id=...>, o parser lia o cStat 104 do lote e marcava REJECTED uma nota autorizada. |
| Causa | Regex da abertura de infProt exigindo a tag nua; o leiaute 4.00 declara Id opcional e a SVRS o preenche, entao a leitura caia no cStat do lote. |
| Correção | parseSefazResponse passa a abrir qualquer tag com (?:\s[^>]*)? — aceita atributo (e so atributo: <infProtX> continua fora), com ou sem prefixo de namespace; o bloco infProt manda no cStat/xMotivo/nProt/chNFe quando existe. |
| DEPOIS | A abertura aceita atributos e prefixo de namespace, mas não <infProtX>. cStat, xMotivo, nProt e chNFe vêm de dentro do infProt quando ele existe. |
| Arquivos | server/src/services/core/SefazAdapter.ts, server/tests/sefaz-protocolo-com-id.test.ts |
| COMMIT | 8bf8346 |
| TESTES | server/tests/sefaz-protocolo-com-id.test.ts: infProt com Id dá AUTHORIZED, cStat 100 e protocolo; rejeição 225 e duplicidade 539 dentro de infProt Id=; prefixo nfe:; tag sem atributo continua valendo; <infProtX> não conta; a fila de ponta a ponta com o adapter real deixa o documento AUTHORIZED. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/SefazAdapter.ts:169-188 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Nenhum insumo para o parser. A homologacao real na SVRS (A1 do grupo) e o juiz final do formato de resposta — nenhuma linha de codigo depende dela. |

### GAP-PRD-005 — Cancelamento, carta de correção e inutilização pela tela só alcançam o SIMULADOR (developmentMode:true) — em produção respondem 500

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas as seis / FIS |
| ANTES | A tela mandava developmentMode:true nos três atos e só chegava ao simulador: protocolo TEST- em homologação e erro 500 em produção. Não havia campo de senha nem uso do cofre. |
| Causa | O provider dos atos administrativos era escolhido por uma bandeira do CLIENTE, e o uso do segredo selado nesses atos era "decisao a parte, ainda nao tomada" — sem mecanismo, a tela so alcancava o simulador. |
| Correção | Servidor: FiscalAtosAdministrativos decide o caminho pela PROCEDENCIA da nota (ensaio TEST-/fixture so pelo simulador e nunca em producao; nota da SEFAZ so pela SEFAZ; developmentMode sobre nota real recusado 409; inutilizacao vai a SEFAZ e o simulador so com pedido explicito fora de producao); o A1 vem da senha digitada (ganha quando vem) ou do cofre (senha selada), conforme a politica do dono em core_fiscal_act_policies (padrao seguro: cofre — a senha nao trafega pelo navegador; PUT /fiscal/acts/policy so donos, com auditoria fiscal.act_policy_updated); GET /fiscal/acts/plan devolve caminho, ambiente, senha (OPCIONAL/OBRIGATORIA), situacao do cofre e motivo — a mesma decisao que o ato executa; o adapter e fabricado depois das validacoes da nota e antes de registrar o pedido/reservar a faixa/sequencia. Tela: cliente sem developmentMode e com certificatePassword opcional; quadro CaminhoDoAtoFiscal nos dialogos de cancelar e carta de correcao e na inutilizacao (SEFAZ com ambiente, simulador sem valor fiscal, bloqueado com motivo; senha do A1 quando pedida; botao preso quando bloqueado ou sem senha obrigatoria); cartao PoliticaDosAtosFiscaisCard em Fiscal > Certificado. |
| DEPOIS | O cliente não manda mais developmentMode e a senha é opcional. O servidor decide o caminho pela procedência da nota. O A1 vem da senha digitada ou do cofre, conforme a política do dono (PUT só para donos, auditado). A rota de plano devolve o caminho. O evento aceito guarda o procEventoNFe/procInutNFe. As telas mostram o caminho e pedem a senha quando ela é necessária. |
| Arquivos | server/src/services/core/FiscalAtosAdministrativos.ts, server/src/services/core/FiscalEventsService.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, server/tests/atos-fiscais-pela-tela.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/core.ts, src/lib/api/fiscalAtos.ts, src/components/gs/CaminhoDoAtoFiscal.tsx, src/components/gs/planoDoAtoFiscal.ts, src/components/gs/PoliticaDosAtosFiscais.tsx, src/pages/gs/FiscalDocumentosPage.tsx, src/pages/gs/FiscalInutilizacoesPage.tsx, src/pages/gs/CertificadoPage.tsx, src/pages/gs/__tests__/atosFiscaisPelaTela.test.tsx, src/lib/api/__tests__/atosFiscaisSemModoDeDesenvolvimento.test.ts, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | fa45994, 0462b74 |
| TESTES | server/tests/atos-fiscais-pela-tela.test.ts: cancelamento de NFC-e real no host da NFC-e com procEventoNFe; CC-e de NF-e real; inutilização com ano e procInutNFe; corpo antigo com developmentMode sobre nota real dá 409 sem cancelar; sem A1 dá 409 e não cai no simulador; política (403, senha obrigatória, senha certa passa); plano. Tela: atosFiscaisPelaTela.test.tsx e atosFiscaisSemModoDeDesenvolvimento.test.ts. Rodei: verdes. |
| EVIDÊNCIA | src/lib/api/core.ts:4369-4405; server/src/services/core/FiscalAtosAdministrativos.ts:83-117 (política + auditoria fiscal.act_policy_updated), 188-299 (plano), 366-403 (adapter); server/src/routes/v1/core.ts:8042-8051, 8060-8069, 8105-8119, 8245-8330 (companyId do token, requireProfile gerente_loja/gerente_oficina); server/src/services/core/FiscalEventsService.ts:191 e 358 (xml_proc só do aceito); src/pages/gs/FiscalDocumentosPage.tsx:799,899; src/pages/gs/FiscalInutilizacoesPage.tsx:219,365; src/pages/gs/CertificadoPage.tsx:148 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Emanuel: reenviar o .pfx com a senha (GAP-PRD-023) para dispensar a senha digitada, e fazer em homologação na SVRS um cancelamento, uma CC-e e uma inutilização reais. Até lá a tela pede a senha, e isso já funciona. |

### GAP-PRD-006 — Checkout público com CPF alheio sobrescreve o cadastro da vítima e entrega histórico + cancelamento dos pedidos dela

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / SECURITY_RISK |
| Empresa / frente | todas as cinco lojas de varejo (e Oficina, pois core_customers é por operação e o vínculo por documento atravessa o grupo) / ECO |
| ANTES | Checkout público com o CPF da vítima reescrevia e-mail, telefone e endereço dela. A conta do atacante, com co-prova fabricada, via e cancelava os pedidos dela, e o CPF digitado se propagava ao grupo. |
| Causa | Tres elos: (1) findOrCreateCustomer reescrevia o contato do cadastro achado pelo CPF, e os dois chamadores sao automaticos (checkout publico e espelho do equipamento); (2) o pedido era de "qualquer conta ligada ao cadastro" e o cadastro e achado pelo CPF digitado; (3) syncLinks propagava ao grupo o documento de qualquer vinculo, inclusive o CPF digitado num checkout. |
| Correção | findOrCreateCustomer nao reescreve cadastro achado (so carimba documento em cadastro sem documento achado por e-mail); visitante com documento casa so pelo documento (CheckoutIdentityService.cadastroDoVisitante, origin loja_online). Pedido pertence a quem provou que o fez: core_orders.customer_account_id ou, no pedido de visitante, o e-mail provado digitado nele (CustomerPortalService.filtroDoDono) — lista, detalhe e cancelamento. syncLinks grava a prova de cada vinculo (proof): co-prova so liga cadastro que carrega o e-mail provado; documento so se propaga de vinculo de convite ou de cadastro feito no balcao (core_customers.origin = balcao, gravado por createCustomer). Com conta, cadastroDaConta usa o cadastro fiscal do CPF sem ligar nem alterar quando nao ha co-prova. |
| DEPOIS | findOrCreateCustomer não reescreve cadastro achado; só carimba documento em cadastro sem documento. O pedido pertence à conta que o fechou ou ao e-mail provado digitado nele (lista, detalhe e cancelamento). syncLinks só propaga documento de convite ou de cadastro de balcão. |
| Arquivos | server/src/services/core/CatalogService.ts, server/src/services/core/CheckoutIdentityService.ts, server/src/services/core/CustomerPortalService.ts, server/src/services/core/EquipmentPortalService.ts, server/src/services/core/StorefrontService.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/checkout-cpf-alheio-nao-sequestra.test.ts, server/tests/checkout-exige-conta.test.ts, server/tests/ecommerce-jornada.test.ts, server/tests/conta-cliente-completa.test.ts, server/tests/portal-do-dono.test.ts, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 7893a43, 9d3c286 |
| TESTES | server/tests/checkout-cpf-alheio-nao-sequestra.test.ts: afirma cadastro da vítima intacto após checkout do atacante (:151-164); lista sem o pedido da vítima e detalhe 404 (:183-197); cancelar 404 e status aguardando_pagamento (:199-213); sem vínculo ao cadastro da vítima, nem em outra loja, nem no login seguinte (:215-275); PUT /portal/perfil não renomeia a vítima (:247-261); findOrCreateCustomer por documento não troca contato (:307+). checkout-exige-conta bloco GAP-PRD-006 (:409-468). Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/CatalogService.ts:1797-1826 (bloco existente sem UPDATE de contato); CheckoutIdentityService.ts:415-433 (visitante casa só por documento, origin loja_online) e 456-545 (cadastroDaConta: sem co-prova usa, não liga, não altera); CustomerPortalService.ts:1254-1263 (filtroDoDono), 1387-1403 (getCustomerOrder), 153-231 (syncLinks com proof; documento só de convite/documento ou origin=balcao, :216); storefront.ts:1150-1159 (cancelar passa por getCustomerOrder). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-007 — Tela de e-mails entrega ao gerente o token de recuperação de senha e o código de verificação do cliente — takeover de conta provado E2E

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P0 / SECURITY_RISK |
| Empresa / frente | Todas (qualquer gerente_loja/gerente_oficina/gestor/admin_geral de qualquer empresa; a conta do cliente é do grupo, e o e-mail de conta cai na empresa do vínculo ou na primeira ativa) / EML |
| ANTES | O body_text da fila levava o link com token e o código de verificação. GET /core/emails o devolvia ao gerente, e o gerente tomava a conta do cliente. |
| Causa | A redação do segredo valia só para o payload; o corpo guardado (o que a rota e a tela mostram) carregava o segredo em claro, e a linha da fila nunca é podada. |
| Correção | Corpo guardado com MARCA_DO_CONTEUDO_PROTEGIDO no lugar do segredo; segredo selado pelo cofre (encryptFiscalSecret) na tabela nova core_email_segredos (DDL canônica, CORE_TABLES_IN_DELETE_ORDER, inventário do cofre para a rotação), com expira_em de 1 h; só o carteiro abre (montarTexto) e apaga ao entregar, desistir ou vencer; o prazo anda mesmo sem SMTP (mensagem vencida desiste dizendo que o cliente peça outro); corpo com marcador e sem segredo não sai; listEmailQueue mascara linhas legadas e o carteiro mascara o corpo legado quando a mensagem termina; queuePasswordResetEmail passa a devolver o id da mensagem (devolvia lastInsertRowid). A tela explica que o link é só do cliente. Limpeza em lote das linhas antigas descrita em migracoes/EML.md (M1-2). |
| DEPOIS | O corpo guardado leva só um marcador. O segredo fica cifrado em core_email_segredos, com 1 h de prazo, e só o carteiro o abre. Ele é apagado quando a mensagem sai, desiste ou vence. A rota também mascara linhas antigas, e um passo de migração limpa o que já estava gravado. |
| Arquivos | server/src/services/notifications/EmailService.ts, server/src/db/schema.ts, server/src/db/secretsInventory.ts, server/tests/fila-de-email-sem-segredo.test.ts, src/pages/gs/EmailsPage.tsx, src/pages/gs/__tests__/EmailsPage.test.tsx, docs/audits/remediacao/migracoes/EML.md, server/tests/audit-workshop.test.ts, server/tests/cadastro-por-email.test.ts, server/tests/conta-cliente-completa.test.ts, server/tests/equipamento-no-estoque.test.ts, server/tests/loja-avaliacoes-rotas.test.ts, server/tests/loja-avaliacoes.test.ts, server/tests/oficina-orcamento-e-fechamento.test.ts, server/tests/portal-cancelamento.test.ts, server/tests/portal-cliente.test.ts, server/tests/portal-do-dono.test.ts, server/tests/reserva-da-oficina.test.ts |
| COMMIT | 6d929ce, 95d1de1 |
| TESTES | server/tests/fila-de-email-sem-segredo.test.ts: gerente_loja faz GET /core/emails e a resposta não contém o token, o código nem 'token='. O banco em repouso não guarda nenhum dos dois. O cliente recebe o link real, que redefine a senha. O cofre fica vazio depois do envio. Link vencido desiste. Linha antiga sai mascarada. EmailsPage.test.tsx: 'o corpo mostra o marcador'. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/notifications/EmailService.ts:798 (MARCA_DO_CONTEUDO_PROTEGIDO), :909-936 (enfileirarComSegredo cifra e grava em core_email_segredos), :1010-1039 e :1121-1151 (reset e verificação com o marcador), :1382 (listEmailQueue mascara linha antiga), :1686-1761 (apaga o segredo, mascara o corpo, vence o prazo mesmo sem SMTP), :1785-1794 (montarTexto só no carteiro), :1804 (textoDeEntrega não é usado por nenhuma rota; grep em server/src só acha a definição); server/src/routes/v1/core.ts:14185-14206; server/src/db/consolidacaoDaRemediacao.ts:221-230 (migração das linhas antigas); src/pages/gs/EmailsPage.tsx:94. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-008 — Maquininha: chave de idempotência não segura duas chamadas concorrentes e a transação só é gravada DEPOIS da resposta do provedor

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas as seis (qualquer operação que ligue maquininha integrada) / PAG |
| ANTES | A cobrança buscava a chave, esperava o provedor e só depois gravava. Duas chamadas simultâneas geravam duas linhas e duas cobranças, e uma queda no meio não deixava rastro. |
| Causa | createAndProcessPaymentTerminalTransactionBackend fazia busca-da-chave -> await provedor -> insertRow numa colecao de documentos sem UNIQUE; a transacao so nascia depois da resposta. |
| Correção | Tabela nova core_payment_terminal_charge_keys (PRIMARY KEY company_id+idempotency_key) na DDL canonica e na ordem de exclusao; reservarCobranca cria reserva + linha in_progress/providerCallState=awaiting_provider numa transacao BEGIN IMMEDIATE ANTES do provedor; registro em memoria das cobrancas em voo faz a segunda chamada aguardar a primeira; isTerminalChargeOrphan faz a linha que ficou esperando sem ninguem vivo aparecer como timeout_nao_confirmado (fila de conferencia, reconciliavel, reenvio devolve a mesma sem chamar o provedor); provedor que lanca vira timeout_uncertain com providerError; resposta tardia nao sobrescreve decisao do gestor (vai para payment_terminal_history como late_provider_answer); chave obrigatoria (400 PAYMENT_TERMINAL_IDEMPOTENCY_REQUIRED); dashboard conta as orfas como nao confirmadas. |
| DEPOIS | A chave é obrigatória (400). Uma chamada em voo no mesmo processo é aguardada. A reserva em core_payment_terminal_charge_keys (PRIMARY KEY empresa+chave) e a linha in_progress/awaiting_provider nascem numa transação BEGIN IMMEDIATE antes do provedor. Uma linha órfã vira timeout_nao_confirmado na fila de conferência, o reenvio devolve a mesma linha sem chamar o provedor, e a resposta tardia vai para o histórico sem sobrescrever o gestor. |
| Arquivos | server/src/db/schema.ts, server/src/services/payment-terminal/PaymentTerminalService.ts, server/src/services/core/PdvTerminalService.ts, server/tests/maquininha-uma-cobranca-por-chave.test.ts |
| COMMIT | 25fce09 |
| TESTES | server/tests/maquininha-uma-cobranca-por-chave.test.ts: Promise.all com a mesma chave dá 1 chamada ao provedor e 1 linha (inclusive pela rota HTTP); chaves iguais em empresas diferentes dão duas cobranças; nasce in_progress antes da resposta; o INSERT duplicado na reserva lança UNIQUE/PRIMARY KEY; sem chave, rejeita com 400; após o reinício simulado, a órfã é não confirmada, o reenvio não chama o provedor e a resposta tardia não sobrescreve a conciliação. Rodado: verde. |
| EVIDÊNCIA | server/src/services/payment-terminal/PaymentTerminalService.ts:479-486 (chave obrigatória), :519-561 (em voo, reserva, execução), :592-598 (isTerminalChargeOrphan), :612-690 (reservarCobranca com INSERT na tabela de reservas); server/src/db/schema.ts:4639-4645 (PRIMARY KEY (company_id, idempotency_key)); server/src/services/core/PdvTerminalService.ts:414 (órfã vira timeout_nao_confirmado); server/src/services/payment-terminal/PaymentTerminalTransactionEffects.ts:50 (late_provider_answer). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-009 — Devolução com desconto de cabeçalho devolve mais do que o cliente pagou

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas as seis (qualquer venda de balcão com desconto no rodapé) / PAG |
| ANTES | A devolução integral de uma venda de R$ 180 (R$ 200 menos R$ 20 de desconto de rodapé) tirava R$ 200 do caixa, com resposta 201. |
| Causa | O valor devolvido lia so core_sale_items.total_cents; o desconto de cabecalho (core_sales.discount_cents) nunca era rateado nas linhas, e nao havia teto pelo total da venda. |
| Correção | SaleReturnService.liquidoDasLinhas rateia o desconto do rodape pela proporcao de cada linha no subtotal em centavos inteiros (BigInt; parcela = piso, resto um centavo por linha para as maiores fracoes, empate pela ordem da venda); o valor da parcela sai do liquido (valorDaParcelaDevolvida); trava 409 CORE_RETURN_EXCEEDS_PAID quando a soma das devolucoes passaria do total da venda, dizendo quanto resta; estorno de comissao divide pela base comissionavel (subtotal - desconto), a mesma medida do valor devolvido (comissoes.test com desconto de cabecalho segue verde); GET /sales/:id/returnable devolve net_total_cents e returned_cents; a tela de Devolucoes calcula "A devolver" pela mesma conta (src/lib/valorDaDevolucao.ts) e explica o rateio. De passagem, mesma invariante: cancelSale desconta o que uma devolucao em dinheiro ja tirou da gaveta (medido antes: a gaveta terminava em -R$ 50 numa venda de R$ 100 com metade devolvida em dinheiro e o resto cancelado). |
| DEPOIS | O desconto do rodapé é rateado nas linhas em centavos inteiros (BigInt, resto para as maiores frações), e a devolução usa o líquido. Uma trava 409 CORE_RETURN_EXCEEDS_PAID recusa quando a soma das devoluções passaria do total da venda e diz quanto resta. A consulta de devolvíveis traz net_total_cents e returned_cents, e a tela usa a mesma conta. |
| Arquivos | server/src/services/core/SaleReturnService.ts, server/src/services/core/CommissionService.ts, server/src/services/core/SalesService.ts, server/tests/devolucao-devolve-o-que-entrou.test.ts, server/tests/dinheiro-em-centavos-exatos.test.ts, server/tests/dinheiro-so-com-gaveta.test.ts, src/lib/valorDaDevolucao.ts, src/lib/api/core.ts, src/pages/gs/DevolucoesPage.tsx, src/pages/gs/__tests__/devolucaoDevolveOQueEntrou.test.tsx, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | 96fcb09, 089fc5e |
| TESTES | server/tests/devolucao-devolve-o-que-entrou.test.ts: 2×100 com 20 de desconto devolve 18000 e a saída financeira é 18000; parcial 9000+9000; três linhas com 100 de desconto dão líquidos 986/1971/3943 somando 6900; excesso sobre o total dá 409 com 'R$ 80,00' e nada gravado. server/tests/dinheiro-em-centavos-exatos.test.ts. src/pages/gs/__tests__/devolucaoDevolveOQueEntrou.test.tsx: a tela anuncia R$ 180,00. Rodados: verdes. |
| EVIDÊNCIA | server/src/services/core/SaleReturnService.ts:192-225 (liquidoDasLinhas), :368-369 e :428-434 (valor pela parcela do líquido), :499-517 (trava CORE_RETURN_EXCEEDS_PAID), :949-957 (net_total_cents); src/lib/valorDaDevolucao.ts (a mesma conta na tela). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-010 — gerente_loja/gerente_oficina toma a conta do admin_geral e rebaixa gestor/admin por PATCH — PERFIS_DE_DONO não inclui admin_geral e o PATCH não confere o alvo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / SECURITY_RISK |
| Empresa / frente | Todas as seis (latente hoje: não existe gerente_loja/gerente_oficina no banco real; o gestor pode criá-los pela tela Usuários e equipe a qualquer momento, e precisará criá-los para a alçada funcionar por loja) / SEG |
| ANTES | Um gerente_loja trocava a senha do admin_geral, o desativava e rebaixava gestor ou admin por PATCH (200). PERFIS_DE_DONO não tinha admin_geral e o PATCH não conferia o perfil atual do alvo. |
| Causa | Duas listas soltas (PERFIS_DE_DONO para atribuicao, assertPodeMexerNoAlvo para alvo) que esqueciam admin_geral, e o PATCH que nao conferia o perfil ATUAL do alvo. |
| Correção | Novo HierarquiaDePerfis.ts: tres niveis por capacidade (responde pelo grupo=admin_geral/gestor, monta o time=gerente_loja/gerente_oficina, nenhum) e exigencia por perfil-alvo (admin_geral/gestor/contador e perfil desconhecido exigem o topo, falha fechada). assertPodeAtribuir, assertPodeMexerNaOperacao, assertPodeMexerNaConta e acoesSobre. TeamService usa-os em create/update/active/password; updateTeamMember confere o alvo antes de qualquer campo e so exige alcance de conta quando nome/e-mail mudam de fato. GET /core/team devolve acoes por pessoa; a criacao de empresa passa perfisDoCriador ao primeiro gerente (caminho sem perfis agora nao entrega perfil nenhum). EquipePage esconde Editar/Resetar/Desativar em conta de dono e diz por que. |
| DEPOIS | Cada perfil tem um nível de alcance. admin_geral, gestor, contador e qualquer perfil desconhecido exigem o nível mais alto (falha fechada). O PATCH confere o alvo antes de qualquer campo, e senha e desativação usam a mesma guarda da conta. Os perfis vêm do token (scope), nunca do corpo. A tela esconde Editar/Resetar/Desativar em conta de dono e diz por quê. |
| Arquivos | server/src/services/core/HierarquiaDePerfis.ts, server/src/services/core/TeamService.ts, server/src/routes/v1/core.ts, server/src/services/auth/IdentityService.ts, src/lib/api/equipe.ts, src/pages/gs/EquipePage.tsx, server/tests/hierarquia-da-equipe.test.ts, src/pages/gs/__tests__/equipeHierarquia.test.tsx, server/tests/contador-varredura-das-rotas.test.ts |
| COMMIT | 9c830f6 |
| TESTES | server/tests/hierarquia-da-equipe.test.ts: [A1]-[A5] esperam 403 CORE_TARGET_ABOVE_YOURS e conferem no banco que senha, active, perfil, nome e e-mail não mudaram; também gerente de oficina, bancadas do admin, pares gestor/admin e o gerente seguindo ativo na própria equipe. src/pages/gs/__tests__/equipeHierarquia.test.tsx: nenhum botão na linha do admin_geral. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/HierarquiaDePerfis.ts:102-127 (admin_geral em POR_QUE_E_DE_DONO; exigenciaDe falha fechada), :189-229; server/src/services/core/TeamService.ts:514-515 (alvo conferido no início de updateTeamMember), :628 (active), :684 (password); server/src/routes/v1/core.ts:9132-9197 (perfisDeQuemCria/perfisDeQuemAge = scope(req).profiles); src/pages/gs/EquipePage.tsx:47-48, :360-368. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-011 — Estado do backup invisível: /system/backup/status é cravado (lastBackup:null) e nenhuma tela mostra último backup local, cópia remota, disco ou pacote de uploads

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | todas / DEP |
| ANTES | GET /system/backup/status respondia lastBackup:null cravado, sem ler nada. Nenhuma tela mostrava backup local, cópia remota, disco ou fotos; só havia log em stdout. |
| Causa | o diario so falava no stdout; nao havia registro das execucoes nem leitor do estado; a regra de banco descartavel do backup era a do caminho padrao, nao a da declaracao |
| Correção | core_backup_execucoes (DDL canonica) com o resultado de cada etapa de cada execucao; services/backup/estadoDoBackup (itens PRONTO/PENDENTE/FALHOU com data e como resolver: copia diaria, outro disco, bucket, fotos, bucket conferido; falhas de 30 dias; ultimas execucoes; nunca chave nem URL); GET /system/backup/status real e POST /system/backup/conferir-bucket (system-backup.manage, auditado em core_audit_log) que le o bucket e confere o ultimo .db enviado e cada foto do ultimo conjunto; tela Configuracoes > Backup (admin_geral e gestor) com menu, rota e espelhos; a copia so pula banco declarado descartavel (:memory: ou TEST_DATABASE_PATH). |
| DEPOIS | A rota lê a pasta (listarBackups), o registro core_backup_execucoes, a configuração remota (só se existe), o disco e a conferência do bucket. Devolve itens PRONTO/PENDENTE/FALHOU com data, detalhe, como resolver e as falhas de 30 dias. POST conferir-bucket lê o bucket e grava auditoria. A tela Configurações > Backup está no menu e na rota. |
| Arquivos | server/src/services/backup/estadoDoBackup.ts, server/src/services/backup/registroDoBackup.ts, server/src/services/backup/diarioDoBackup.ts, server/src/routes/v1/system-admin.ts, server/src/db/backup.ts, server/src/db/schema.ts, src/lib/api/backup.ts, src/pages/gs/BackupPage.tsx, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, src/router/__tests__/environments.test.tsx, server/tests/setup.ts |
| COMMIT | d6c2024, 9842245 |
| TESTES | server/tests/o-estado-do-backup-aparece.test.ts: 401 sem sessão, 403 para gerente_loja, backup na pasta aparece (sem lastBackup), PENDENTE sem cópia, FALHOU com 30 h, ENOSPC FALHOU com a mensagem na tela e no log, remoto não configurado PENDENTE, diário real com bucket de mentira PRONTO, conferência + auditoria, foto sumida FALHOU, chave trocada = 401 sem vazar chave. src/pages/gs/__tests__/BackupPage.test.tsx. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/routes/v1/system-admin.ts:206-208 (GET com system-backup.view) e 215-235 (POST conferir-bucket com system-backup.manage + recordAudit); server/src/services/backup/estadoDoBackup.ts:360-419 (estado real), 437-511 (conferência); server/src/services/backup/diarioDoBackup.ts:166 (registrarExecucao grava cada execução); src/pages/gs/BackupPage.tsx:82-199; src/router/gsRoutes.tsx:338; src/components/gs/navItems.ts:994 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-012 — Não há caminho de restauração a partir do bucket sem programar: nenhum comando chama baixarBackupRemoto/baixarPacoteDeUploads/restaurarUploadsEm

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | todas / DEP |
| ANTES | Nenhum comando chamava baixarBackupRemoto, baixarPacoteDeUploads ou restaurarUploadsEm. As fotos não voltavam do bucket sem código novo. |
| Causa | as funcoes de volta existiam sem porta de entrada para o operador |
| Correção | services/backup/restauracaoDoBucket (listarBucket com paginacao ate a pagina vazia; baixarBancoDoBucket recusa destino existente e so da nome ao download que passa no integrity_check; restaurarFotosDoBucket le o conjunto versao 2 por objetos e o pacote versao 1, confere sha256, nunca por cima e retoma; restaurarTudoDoBucket em pasta nova e imprime DEVORA_DATABASE_PATH e DEVORA_UPLOADS_DIR); comandos listar-bucket, baixar-backup, restaurar-uploads, restaurar-do-bucket (npm run db:bucket, db:baixar, db:restaurar-uploads, db:restaurar-do-bucket; dist em producao; saida por process.exitCode); DEPLOY.md com o roteiro do disco morto; GO_LIVE_CHECKLIST com ensaio da volta e a chave do cofre fora do servidor. |
| DEPOIS | Há quatro comandos de operador: listar-bucket, baixar-backup, restaurar-uploads e restaurar-do-bucket. Estão em npm scripts e no dist. restaurar-do-bucket traz o .db (integrity_check) e as fotos (sha256) numa pasta nova e imprime as linhas do .env. DEPLOY.md tem o roteiro de disco morto. |
| Arquivos | server/src/services/backup/restauracaoDoBucket.ts, server/src/services/backup/bucket.ts, server/src/scripts/listar-bucket.ts, server/src/scripts/baixar-backup.ts, server/src/scripts/restaurar-uploads.ts, server/src/scripts/restaurar-do-bucket.ts, package.json, docs/DEPLOY.md, docs/GO_LIVE_CHECKLIST.md |
| COMMIT | 81b20ba, d6c2024 |
| TESTES | server/tests/a-volta-do-bucket-sem-programar.test.ts: os comandos rodam como processo filho contra um bucket de mentira local. Afirma: sem config sai 1, --ultimo traz o .db que abre, destino existente recusado, .db quebrado recusado, fotos v2 byte a byte, pacote v1, foto adulterada recusada, pasta nova com as duas linhas do .env, pasta não vazia recusada. Rodei: verde. |
| EVIDÊNCIA | server/src/scripts/restaurar-do-bucket.ts:24-60; server/src/scripts/listar-bucket.ts, baixar-backup.ts, restaurar-uploads.ts; package.json:73-76 (db:bucket, db:baixar, db:restaurar-uploads, db:restaurar-do-bucket); server/src/services/backup/restauracaoDoBucket.ts:280 (linhas DEVORA_DATABASE_PATH/DEVORA_UPLOADS_DIR); server/tsconfig.json include src/** (os scripts vão ao dist); docs/DEPLOY.md:363-391; docs/GO_LIVE_CHECKLIST.md:48 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional, não é código: um ensaio real de restaurar-do-bucket contra o bucket de produção, com a credencial de Emanuel. A DEVORA_ENCRYPTION_KEY precisa ser a mesma de antes. |

### GAP-PRD-013 — O repositório não serve o frontend nem traz proxy/host estático, HTTPS ou supervisor: hoje a instalação roda o Vite de desenvolvimento (3000) e a API (8787) à mão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / OWNER_DECISION_REQUIRED |
| Empresa / frente | todas / DEP |
| ANTES | O repositório não servia o frontend e não tinha proxy, HTTPS nem supervisor. A loja rodava Vite de desenvolvimento e a API à mão. Deep link dava 404. |
| Causa | publicacao inteira delegada ao dono: sem host das telas com fallback de SPA, sem exemplo de HTTPS, sem supervisor e sem log persistente fora de terminal |
| Correção | API serve out/ com fallback de SPA sob DEVORA_SERVIR_FRONTEND (padrao false; ligada sem index recusa subir; /api e /uploads fora; asset faltando = 404; cache imutavel so em assets). Supervisor Node (scripts/supervisionar-api) com reinicio em espera crescente, IPC para desligar, log por dia da loja com carimbo e retencao, canal de controle local (scripts/parar-api) para parada limpa e contra segundo supervisor. deploy/: Caddyfile (HTTPS automatico, HSTS, dois modos, LAN), nginx, systemd, instalar/remover tarefa do Windows (confere antes, -Ensaio, -Caddy). Conferencia da implantacao (servico + comando conferir-implantacao + GET /api/v1/system/implantacao + tela Configuracoes > Implantacao). Imagem Docker builda com VITE_API_BASE_URL=/ e serve as telas; compose com Caddy no perfil https. DEPLOY.md e GO_LIVE_CHECKLIST reescritos. |
| DEPOIS | Com DEVORA_SERVIR_FRONTEND=true a API serve out/ com fallback de SPA (fora /api e /uploads, 404 para asset que falta). Há supervisor Node, instalador de tarefa do Windows, unidade systemd, Caddyfile (domínio com HTTPS automático, ou LAN com tls internal), nginx de exemplo, HSTS por HTTPS e conferência da implantação (comando, rota e tela). A escolha de topologia é só configuração. |
| Arquivos | server/src/services/implantacao/frontendEstatico.ts, server/src/services/implantacao/supervisor.ts, server/src/services/implantacao/registroEmArquivo.ts, server/src/services/implantacao/canalDeControle.ts, server/src/services/implantacao/conferenciaDaImplantacao.ts, server/src/scripts/supervisionar-api.ts, server/src/scripts/parar-api.ts, server/src/scripts/conferir-implantacao.ts, server/src/app.ts, server/src/config/env.ts, server/src/routes/v1/system-admin.ts, src/pages/gs/ImplantacaoPage.tsx, src/lib/api/implantacao.ts, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, deploy/caddy/Caddyfile.example, deploy/caddy/Caddyfile.docker, deploy/nginx/grupo-sampaio.conf.example, deploy/linux/grupo-sampaio-api.service, deploy/windows/instalar-servico.ps1, deploy/windows/remover-servico.ps1, Dockerfile, docker-compose.yml, .gitattributes, package.json, docs/DEPLOY.md, docs/GO_LIVE_CHECKLIST.md |
| COMMIT | fb3874f |
| TESTES | Rodei e ficaram verdes: server/tests/a-api-serve-as-telas-com-fallback.test.ts (fallback, 404 de asset, /api fora, CSP das telas), a-conferencia-da-implantacao.test.ts, o-roteiro-de-publicacao-esta-no-repositorio.test.ts e src/pages/gs/__tests__/ImplantacaoPage.test.tsx. Não rodei a-api-tem-quem-a-levante nem o-supervisor-para-quando-pedem: eles sobem uma API real, e a regra do lote proíbe subir servidor. |
| EVIDÊNCIA | server/src/services/implantacao/frontendEstatico.ts:118-175; server/src/app.ts:276; server/src/config/env.ts:162-164; server/src/scripts/supervisionar-api.ts, parar-api.ts, conferir-implantacao.ts; deploy/windows/instalar-servico.ps1; deploy/linux/grupo-sampaio-api.service:25 (Restart=always); deploy/caddy/Caddyfile.example:29 (domínio) e 54-62 (LAN tls internal); deploy/nginx/grupo-sampaio.conf.example:53,58; server/src/middleware/cabecalhosDeSeguranca.ts:20-30 (HSTS); docs/DEPLOY.md:52-94; src/router/gsRoutes.tsx:335 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel escolhe a topologia. (a) Domínio público: DNS A, portas 80/443, caddy.exe e o Caddyfile com o domínio. (b) Só LAN: tls internal e a raiz do Caddy instalada nos PDVs. Depois preenche o .env de produção (DEVORA_SERVIR_FRONTEND=true, DEVORA_TRUST_PROXY=1, DEVORA_FRONTEND_ORIGIN), faz o build com VITE_API_BASE_URL=/ e roda instalar-servico.ps1 como administrador. |

### GAP-PRD-014 — Maquininha/TEF: nenhum provedor real implementado — adapter 'estrutural' devolve failed, Local Agent não tem fila de comandos nem callback; configurar credencial real hoje deixa o balcão SEM cartão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas as seis (qualquer operação que ligar uma maquininha integrada) / PAG |
| ANTES | Não havia provedor real: o adapter estrutural devolvia failed, o agente local não tinha fila nem callback, e cadastrar credencial real deixava o balcão sem cartão. |
| Causa | Nao existia caminho do servidor ate o aparelho: nenhum adaptador real, nenhuma fila para o agente local nem callback de resultado; e cadastro, prontidao e balcao nao perguntavam se o caminho da configuracao existia — qualquer credencial ligava a exigencia de cobranca no cartao. |
| Correção | Canal por configuracao (PaymentTerminalChannels: mock; agente local para qualquer adquirente atendida pelo cliente TEF; nuvem sem adaptador => 409 PAYMENT_TERMINAL_CHANNEL_NOT_IMPLEMENTED no cadastro, na credencial, na ligacao e na cobranca); maquininha real nasce desligada e so liga com o agente DAQUELE caixa pareado. Fila relacional core_payment_terminal_agent_commands (DDL canonica): startPayment enfileirado na mesma transacao da reserva da chave (GAP-PRD-008); prazo de retirada (nao retirado => failed, nada cobrado, dead-letter) e de resposta (=> timeout_uncertain na Conferencia); etapas in_progress (aguardando o cliente, QR); resultado idempotente; resposta tardia aplicada so sem decisao do gestor; treinamento do cliente TEF recusado em producao. Identidade do agente: pareamento publico por codigo de uso unico (8 hex, 10 min) entrega o segredo uma vez (selado no cofre, no inventario da rotacao); pedidos assinados HMAC-SHA256 (metodo, caminho, carimbo de 5 min, nonce unico em core_payment_terminal_agent_nonces, sha256 do corpo cru via rawBody em app.ts); online = sinal < 90 s; revogacao com motivo e auditoria; listagem sem segredo. Cancelar/estornar/consultar cobranca do agente vao pela fila (202) e aplicam pelas mesmas funcoes do caminho sincrono (PaymentTerminalTransactionEffects). Tenant -> caixa -> maquininha -> agente: getTerminalStatus(companyId, caixa) (sem caixa a exigencia continua: requiresTerminal), charge/status/venda com o caixa (terminalDoPedido + assertTerminalDaEmpresa), SalesService confere pela maquininha do caixa da venda. Prontidao por configuracao com homologacao por evidencia de cobranca real; conexao = agente online + saude do cliente TEF. Gerencia exigida (requireProfile gerente_loja/gerente_oficina) em configuracao, credencial, pareamento, revogacao, homologacao, consulta e test-transaction. Programa do agente (server/src/local-agent): cliente assinado, ponte TEF por troca de arquivos (IntPos.001/IntPos.Sts: ATV, CRT, CNC, CNF, NCN), executor com estado local (em andamento, pendencias de CNF/NCN, reentrega de cobranca interrompida => nao confirmada) e CLI parear/saude/rodar. Tela: ver GAP-PRD-076; PagamentoDialog espera o PinPad (consulta a cada 2 s) e avisa agente fora do ar. |
| DEPOIS | Existe o canal agente local, com fila relacional de comandos, pareamento por código de uso único, pedidos assinados HMAC com nonce e carimbo, prazos, resultado idempotente e cancelamento/estorno pela fila. O programa do agente fala com o cliente TEF pela troca de arquivos IntPos (ATV/CRT/CNC/CNF/NCN), com CLI parear/saude/rodar. O canal de nuvem sem adaptador é recusado com 409 no cadastro, na ligação e na cobrança, e a maquininha real nasce desligada. A pergunta decisiva: com PinPad e cliente TEF em modo de troca de arquivos em mãos, não achei linha de código a escrever; o caminho de entrada é Configurações > Maquininhas (cadastro, credencial, gerar código) mais a CLI do agente, documentados em docs/OPERATIONS.md:76-90. Não verifiquei contra um gerenciador TEF real: a ponte foi testada com troca de arquivos simulada. |
| Arquivos | server/src/services/payment-terminal/PaymentTerminalChannels.ts, server/src/services/payment-terminal/PaymentTerminalAgentChannel.ts, server/src/services/payment-terminal/PaymentTerminalAgentAuth.ts, server/src/services/payment-terminal/agentSignature.ts, server/src/services/payment-terminal/PaymentTerminalTransactionEffects.ts, server/src/services/payment-terminal/PaymentTerminalLocalAgentService.ts, server/src/services/payment-terminal/PaymentTerminalService.ts, server/src/services/payment-terminal/PaymentTerminalCredentialService.ts, server/src/services/payment-terminal/PaymentTerminalProviderAdapter.ts, server/src/services/payment-terminal/PaymentTerminalReadinessService.ts, server/src/services/core/PdvTerminalService.ts, server/src/services/core/SalesService.ts, server/src/services/integrations/IntegrationsService.ts, server/src/routes/v1/payment-terminals.ts, server/src/routes/v1/core.ts, server/src/app.ts, server/src/db/schema.ts, server/src/db/secretsInventory.ts, server/src/local-agent/ClienteDoServidor.ts, server/src/local-agent/PonteTef.ts, server/src/local-agent/PonteTefDial.ts, server/src/local-agent/ExecutorDoAgente.ts, server/src/local-agent/main.ts, server/tests/maquininha-pelo-agente-local.test.ts, server/tests/agente-local-programa.test.ts, src/components/gs/PagamentoDialog.tsx, src/lib/api/core.ts, src/pages/gs/PdvPage.tsx, src/components/gs/__tests__/pagamentoCartaoPeloAgente.test.tsx, docs/OPERATIONS.md, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | a1fdfcd, 3abc879, aed8148 |
| TESTES | server/tests/maquininha-pelo-agente-local.test.ts: nuvem recusada; credencial sem modo nasce no agente e desligada; ligar sem agente é recusado; ponta a ponta PDV, fila, agente, aprovado com NSU; assinatura errada, corpo adulterado, nonce repetido e carimbo velho dão 401; prazos; homologação por evidência; treino recusado em produção. server/tests/agente-local-programa.test.ts: a ponte de arquivos cobra, desfaz com o gerenciador fechado, trata recibo sem resposta como não confirmada, e o executor é testado de ponta a ponta. Tela: src/components/gs/__tests__/pagamentoCartaoPeloAgente.test.tsx. Rodados: verdes. |
| EVIDÊNCIA | server/src/services/payment-terminal/PaymentTerminalChannels.ts:67 (ADAPTADORES_DE_NUVEM vazio), :85-155 (canal e recusa); server/src/services/payment-terminal/PaymentTerminalService.ts:535-550 (agente local e recusa da nuvem), :181 (real nasce desligada), :387-390 (ligar exige agente pareado); server/src/local-agent/PonteTef.ts, PonteTefDial.ts (332 linhas), ExecutorDoAgente.ts, main.ts; server/src/services/core/PdvTerminalService.ts:268-289 (agente online/offline no status); docs/OPERATIONS.md:76-90. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_HARDWARE_REQUIRED** — Equipamento externo |
| O que falta | Nada para o caminho escolhido (cliente TEF com troca de arquivos). Limite declarado: se o dono comprar maquininha smart que só fala pela nuvem da adquirente, falta escrever o adaptador de nuvem daquela adquirente (ADAPTADORES_DE_NUVEM vazio). Isso é uma decisão de compra, não uma pendência da ficha como corrigida. |
| Insumo externo | Por caixa: PinPad e o gerenciador TEF licenciado e homologado com a adquirente, configurado na troca de arquivos (pastas REQ/RESP); Node 22+ com server/dist no computador do caixa e o agente como serviço (parear/saude/rodar); a TEF house conferindo os campos IntPos; homologação com cartões reais pelo roteiro da tela. |

### GAP-PRD-015 — Tela de Entrada de Notas não tem caminho para casar item da nota com produto EXISTENTE — todo item não casado vira produto duplicado com preço zero

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas as seis (qualquer operação que importe XML de fornecedor) / EST |
| ANTES | A conferência só tinha 'Dar entrada' com createMissing:true sempre. Item sem casamento automático virava produto duplicado com preço 0. |
| Causa | a conferencia nao tinha gesto de vinculo nem pedia autorizacao para cadastrar; o servidor nao aprendia o codigo do fornecedor e ignorava os codigos de barras adicionais |
| Correção | servidor: tabela nova core_supplier_item_codes (de-para fornecedor+cProd->produto, DDL canonica, na ordem de exclusao); matchItems consulta o de-para primeiro (matchedBy 'supplier_code'), depois barcode principal E adicionais, codigo interno e nome; linkNoteItem em transacao, grava o de-para (lembrar, padrao sim), productId null desfaz e esquece o de-para, recusa grade/kit que desmembra; confirmNfe grava de-para 'cadastro_pela_nota' para o produto que cria (sem atropelar decisao humana); listNoteItems devolve productName/productInternalCode/productUnit; previa usa o de-para do fornecedor ja cadastrado sem criar fornecedor; auditoria com produto anterior e item_desvinculado. tela: botao Vincular/Trocar/Desfazer na linha com busca do catalogo (VincularItemDaNota), caixa 'lembrar o codigo', nome do produto casado na linha, cadastro de produto novo virou segundo gesto com a lista (createMissing so quando autorizado; CORE_UNMATCHED_ITEMS reabre a nota e pergunta). cliente: src/lib/api/entradaNotas.ts |
| DEPOIS | Cada linha da conferência tem Vincular/Trocar/Desfazer com busca no catálogo. O vínculo grava o de-para do fornecedor e o casamento lê também códigos de barras adicionais. createMissing só vai quando o conferente autoriza; sem autorização o servidor recusa com 409 CORE_UNMATCHED_ITEMS. |
| Arquivos | server/src/db/schema.ts, server/src/services/core/NfeImportService.ts, server/src/routes/v1/core.ts, server/tests/entrada-casamento-com-o-catalogo.test.ts, src/lib/api/entradaNotas.ts, src/components/gs/VincularItemDaNota.tsx, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/__tests__/EntradaNotasVinculo.test.tsx |
| COMMIT | 7b53e07 |
| TESTES | server/tests/entrada-casamento-com-o-catalogo.test.ts:234-494 (vínculo entra no produto verdadeiro sem duplicata, de-para aprende e é por fornecedor, lembrar:false, troca e desfaz com trilha, grade/kit recusados, estoquista vincula, produto de outra empresa 404, código adicional casa). src/pages/gs/__tests__/EntradaNotasVinculo.test.tsx:187-348 (busca, vínculo, createMissing só autorizado, releitura em CORE_UNMATCHED_ITEMS). Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/NfeImportService.ts:687-759 (matchItems: de-para, barcode principal+adicional, código interno, nome); :1616-1744 (linkNoteItem em transação, grava/esquece de-para, recusa grade/kit); :1833-1840 (CORE_UNMATCHED_ITEMS sem createMissing); server/src/routes/v1/core.ts:12614-12662 (rota com companyId do token, perfis, auditoria item_vinculado/item_desvinculado com anterior); :12729 (createMissing do corpo); src/lib/api/entradaNotas.ts (linkInboundNoteItem/unlinkInboundNoteItem); src/components/gs/VincularItemDaNota.tsx:70 (searchProducts); src/pages/gs/EntradaNotasPage.tsx:1108-1134, 1165-1183, 1673 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-016 — Conciliação Asaas nunca consulta o provedor: compara intents do ERP com o financeiro, e webhook perdido some do relatório

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas / FIN |
| ANTES | A conciliação só lia as intents que o webhook já tinha movido. AsaasHttpClient.getPayment não tinha chamador, então pagamento sem webhook ficava pending para sempre e fora do relatório. |
| Causa | a conciliacao so conhecia o que o webhook trazia; nenhuma rotina perguntava ao provedor pelas cobrancas em aberto; e a regua de posto tratava pagamento sobre cobranca cancelada no ERP como noticia velha |
| Correção | AsaasSincronizacao.sincronizarCobrancasComProvedor: consulta GET /payments/:id das cobrancas pending/overdue (+ canceladas ha ate 60 dias) da operacao, com teto por passada ordenado por provider_checked_at, e aplica o status pelo mesmo caminho do webhook (PaymentService.aplicarStatusConsultado -> aplicarEventoNaCobranca; so aplica o que muda; cancelada so aceita confirmacao); falha de consulta contada e nomeada sem mudar nada; sem credencial registra unconfigured; cada passada em core_asaas_sync_runs (tabela nova). Botao 'Consultar o provedor agora' (POST /core/asaas/conciliacao/sincronizar, gerencia, auditoria asaas.sync), GET /core/asaas/conciliacao/sincronizacao, e GET /core/asaas/conciliacao devolve {sincronizacao:{last,pendingWithRef}}; passada automatica AsaasSincronizacaoScheduler (1 min apos subir e a cada ASAAS_SYNC_INTERVAL_MINUTES, padrao 30, 0 desliga; .env.example). Webhook de confirmacao sobre intencao cancelled vira paid_after_cancel (pedido cancelado: registerPaymentAfterCancel). Tela: SincronizacaoAsaasCard na ConciliacaoAsaasPage (de quando e a verdade, quantas esperam, o que mudou e o que falhou). |
| DEPOIS | sincronizarCobrancasComProvedor consulta GET /payments/:id das cobranças pending/overdue (e das canceladas há até 60 dias) da operação do token. Ela aplica o status pelo mesmo caminho do webhook (aplicarStatusConsultado → aplicarEventoNaCobranca) e grava cada passada em core_asaas_sync_runs. Dispara por botão (POST com auditoria asaas.sync, só gerência) e sozinha (scheduler no boot, ASAAS_SYNC_INTERVAL_MINUTES). Confirmação sobre cobrança cancelada vira paid_after_cancel. |
| Arquivos | server/src/services/core/AsaasSincronizacao.ts, server/src/services/core/AsaasSincronizacaoScheduler.ts, server/src/services/core/PaymentService.ts, server/src/routes/v1/core.ts, server/src/index.ts, server/src/config/env.ts, server/src/db/schema.ts, .env.example, src/components/gs/SincronizacaoAsaasCard.tsx, src/pages/gs/ConciliacaoAsaasPage.tsx, src/lib/api/cobrancas.ts, docs/audits/remediacao/migracoes/FIN.md, server/tests/conciliacao-consulta-o-provedor.test.ts, src/pages/gs/__tests__/conciliacaoConsultaOProvedor.test.tsx |
| COMMIT | 5553dfc, 8496283 |
| TESTES | server/tests/conciliacao-consulta-o-provedor.test.ts (15 casos): pago no provedor sem webhook → a passada baixa o título e a conciliação passa a ver; o webhook que chega depois não baixa de novo; falha de consulta não muda nada e é contada; sem credencial a passada diz que não consultou; a passada de uma operação não consulta a outra; teto por passada; paid_after_cancel; rota 200 com auditoria e 403 para o caixa; intervalo 0 desliga. src/pages/gs/__tests__/conciliacaoConsultaOProvedor.test.tsx (4 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/AsaasSincronizacao.ts:180-290, 330-354; server/src/services/core/PaymentService.ts:1366-1407 (aplicarStatusConsultado), 1037-1072 (paid_after_cancel); server/src/routes/v1/core.ts:14309-14379 (requireProfile gerente, companyId do token, recordAudit asaas.sync); server/src/services/core/AsaasSincronizacaoScheduler.ts:38-49; server/src/index.ts:135; server/src/config/env.ts:291; .env.example:93 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A credencial Asaas de cada operação (a passada só consulta quem tem chave). |

### GAP-PRD-017 — Asaas: credencial só da Preço Justo; as outras cinco operações não cobram até o dono cadastrar chave e token — sem código novo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Gringa, Me Mimei, Conceito, PJ Motors, Oficina / INT |
| ANTES | Só a Preço Justo tinha chave e token no cofre. As outras cinco operações ficavam 'unconfigured' (409 CORE_ASAAS_UNCONFIGURED). |
| Causa | Insumo externo: credenciais Asaas de cinco operacoes nao cadastradas. |
| Correção | Para o insumo ser a unica coisa faltando e ficar visivel: ProntidaoAsaasDoGrupo e GET /core/integrations/asaas/grupo (so os donos do grupo, escopo do vinculo, sem segredos) listam por operacao o que falta, classificado em credencial, cadastro no painel do Asaas, configuracao do servidor e acao na tela; cartao As operacoes do grupo na tela do Asaas. |
| DEPOIS | Não falta nenhuma linha de código para as outras cinco cobrarem. Chave sandbox, chave de produção e token entram pela tela (PUT /core/integrations/asaas/credentials e /webhook-token). Teste, homologação e pedido de produção também são pela tela (POST test, POST homologar, PATCH environment). A chave do cofre libera o cliente HTTP sem precisar de ASAAS_ENABLED, e cobrança, webhook, baixa e conciliação a usam por companyId. GET /core/integrations/asaas/grupo (só donos, sem segredo) e o AsaasDoGrupoCard listam o que falta em cada operação. |
| Arquivos | server/src/services/core/ProntidaoAsaasDoGrupo.ts, server/src/routes/v1/core.ts, src/components/gs/AsaasDoGrupoCard.tsx, src/lib/api/asaasDoGrupo.ts, src/pages/gs/IntegracaoAsaasPage.tsx, server/tests/asaas-prontidao-do-grupo.test.ts, src/pages/gs/__tests__/asaasDoGrupo.test.tsx |
| COMMIT | 8f7c7a8, 66769ce |
| TESTES | server/tests/asaas-prontidao-do-grupo.test.ts (6 casos): só as operações do vínculo; o que falta é classificado como insumo ou ação, nunca código; nenhum segredo sai; o gerente da loja recebe 403; com a chave da Gringa guardada pela rota da tela, o título é cobrado no provedor sem mudar código. src/pages/gs/__tests__/asaasDoGrupo.test.tsx (2 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:13786-13794, 13808, 13863, 13926, 13981, 14017; src/pages/gs/IntegracaoAsaasPage.tsx:136-177 (testAsaasConnection, saveAsaasApiKey, saveAsaasWebhookToken, requestAsaasEnvironment), 187 (AsaasDoGrupoCard); server/src/services/core/ProntidaoAsaasDoGrupo.ts:81-164; server/src/services/asaas/AsaasHttpClient.ts:52-76; server/src/services/core/PaymentService.ts:117-140; .env.example:80,88,94 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Para Gringa, Me Mimei, Conceito, PJ Motors e Oficina: API key sandbox, token do webhook, URL cadastrada no painel do Asaas de cada conta, homologação, API key de produção testada e pedido de produção. No servidor: GRUPO_SAMPAIO_PUBLIC_URL com HTTPS público e ASAAS_PRODUCTION_ENABLED=true. Reemitir as chaves do Preço Justo. |

### GAP-PRD-018 — Portão de produção dos atos administrativos furado: fora de DEVORA_API_ENV=production o simulador entra no slot 'real' e cancela nota de PRODUÇÃO com protocolo TEST-

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / DATA_INTEGRITY_RISK |
| Empresa / frente | Todas as seis / FIS |
| ANTES | Com o servidor fora de DEVORA_API_ENV=production e a operação em produção, o simulador entrava no slot real e cancelava nota de produção com protocolo TEST-. |
| Causa | O portao perguntava QUEM PEDIU o simulador (a bandeira) e olhava so o ambiente declarado do servidor, nao QUEM VAI TRANSMITIR nem o ambiente da operacao/nota. |
| Correção | SefazAdapter: servidorEmProducao (NODE_ENV=production ou DEVORA_API_ENV=production), exigeAdapterReal e assertAdapterPodeTransmitir; selectAdapter recusa useTestProvider e o slot real de teste quando a operacao OU o processo e producao (409). adapterRealOuSimulador recebe o ambiente da operacao e nunca devolve simulador em producao. FiscalAtosAdministrativos aplica o portao duas vezes (plano e adapter) e o servico de eventos confere o adapter contra a operacao, o ambiente da nota e a procedencia (assertAdapterPodeAgirNoDocumento) antes de registrar qualquer coisa — pela rota ou por qualquer chamador. |
| DEPOIS | Produção agora é a da operação, a da nota ou a do processo (NODE_ENV ou DEVORA_API_ENV). selectAdapter recusa o simulador pedido e também o slot real ocupado por adapter de teste (409). adapterRealOuSimulador nunca devolve simulador em produção. Os atos e o serviço de eventos conferem de novo contra a operação, o ambiente da nota e a procedência antes de registrar ou reservar. |
| Arquivos | server/src/services/core/SefazAdapter.ts, server/src/services/core/SefazRealAdapter.ts, server/src/services/core/FiscalAtosAdministrativos.ts, server/src/services/core/FiscalEventsService.ts, server/src/routes/v1/core.ts, server/tests/atos-fiscais-pela-tela.test.ts |
| COMMIT | fa45994 |
| TESTES | server/tests/atos-fiscais-pela-tela.test.ts: cancelar nota de produção sem A1 dá 409 e a nota continua autorizada; simulador em produção dá 409 e não 500; nota de ensaio em operação de produção é recusada; inutilização em produção sem A1 é recusada antes de reservar; com A1 vai ao host de produção da NFC-e com tpAmb 1; selectAdapter recusa o slot real de teste; NODE_ENV=production conta; o serviço recusa adapter de teste sobre nota real e em operação de produção. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/SefazAdapter.ts:363-428; server/src/services/core/SefazRealAdapter.ts:855-875; server/src/services/core/FiscalAtosAdministrativos.ts:207-212, 396-401, 413-430; server/src/services/core/FiscalEventsService.ts:326, 488, 704 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-019 — Adapter real: cancelamento/CC-e de NFC-e vão ao host da NF-e (model '55' cravado); dhEvento em ISO UTC com milissegundos; CNPJ do evento é o do certificado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas as seis (NFC-e no varejo; NF-e na Oficina/pedidos) / FIS |
| ANTES | Cancelamento e CC-e de NFC-e iam ao host da NF-e (modelo 55 fixo). O dhEvento saía em ISO UTC com milissegundos. O CNPJ do evento era o do certificado, e o ano da inutilização vinha do relógio. |
| Causa | O adapter tirava modelo, autor e ano de fontes que nao sao a nota (constante, certificado, relogio da maquina) e formatava a hora do evento fora do leiaute. |
| Correção | Modelo e CNPJ do autor tirados da CHAVE (modelo informado que a desmente: 409 CORE_SEFAZ_MODEL_MISMATCH); NFC-e no host da NFC-e; dhEvento por momentoFiscal no fuso da UF (sem milissegundos, com -03:00 no RS); conferencia da raiz do CNPJ do A1 contra o autor antes de transmitir (409, a SEFAZ responderia 213); CC-e de NFC-e recusada antes da rede; inutilizacao com o ano do pedido (ou o corrente no fuso do emitente), CNPJ do emitente do cadastro obrigatorio e o inutNFe assinado passando pelo XSD oficial inutNFe_v4.00 antes de viajar. Interface: model em cancel, year e cnpj em voidNumberRange. Servico: modelo e AMBIENTE DA NOTA no cancelamento e na CC-e; modelo 55/65, serie 0-999 e ano 2006..ano corrente (fuso do emitente) conferidos antes de reservar a faixa; a rota passa o ano pedido (ausente: o corrente). |
| DEPOIS | Modelo e CNPJ do autor saem da chave (modelo divergente dá 409) e o host segue o modelo. O dhEvento usa momentoFiscal no fuso da UF, sem milissegundos. A raiz do CNPJ do A1 é conferida. CC-e de NFC-e é recusada antes da rede. A inutilização usa o ano do pedido e o CNPJ do emitente do cadastro (obrigatório). O serviço valida modelo, série e ano antes de reservar a faixa. |
| Arquivos | server/src/services/core/SefazRealAdapter.ts, server/src/services/core/SefazAdapter.ts, server/src/services/core/FiscalEventsService.ts, server/src/routes/v1/core.ts, server/tests/sefaz-eventos-nfce-e-nfe.test.ts, server/tests/sefaz-adapter-real.test.ts, server/tests/fiscal-assinatura-c14n.test.ts |
| COMMIT | e595214, fa45994 |
| TESTES | server/tests/sefaz-eventos-nfce-e-nfe.test.ts: host por modelo em homologação e produção; modelo divergente; CC-e de NFC-e recusada; dhEvento no padrão TDateTimeUTC do XSD; A1 da matriz na filial com o CNPJ da filial; outra raiz recusada; ano 2025 em janeiro de 2026; inutNFe no XSD; sem CNPJ recusado; ano e modelo inválidos recusados antes de reservar. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/SefazRealAdapter.ts:307-309 (dhEvento), 520-543 (eventoDoEmitente), 545-574 (cancel), 586-595 (CC-e só 55), 656-720 (inutilização com cnpj e ano); server/src/services/core/MomentoFiscal.ts:104; server/src/services/core/FiscalEventsService.ts:326-345 (modelo e ambiente da nota), 789-801 (ano e CNPJ); server/src/routes/v1/core.ts:8315-8318 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A homologação real na SVRS, com o A1 de Emanuel, é o juiz final dos endereços e do leiaute. Nenhuma linha de código depende dela. |

### GAP-PRD-020 — Fila fiscal sem worker: item preso só anda na próxima emissão da mesma empresa, um por chamada, e a nova venda fica QUEUED; contingência sem botão de volta

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas as seis / FIS |
| ANTES | Não havia trabalhador de fundo. O item preso só andava na próxima emissão da mesma empresa, um por chamada, e a venda nova ficava QUEUED. A contingência não tinha botão de volta. |
| Causa | A fila so era drenada por quem emitia: um item por requisicao, o mais antigo da empresa, e so se houvesse outra emissao; a transmissao usava o ambiente da configuracao atual e nao o da nota; nao existia trabalhador de fundo nem gesto de tela. |
| Correção | processNext/claimNext aceitam documentId (a emissao transmite so a nota da venda) e transmitem no ambiente da NOTA. FiscalQueueWorker: laco de fundo ligado no index.ts (tique 1 min, unref, sem passadas sobrepostas) que (1) sonda a SEFAZ (statusServico no host do modelo, no maximo a cada 2 min) para as empresas que esperam por indisponibilidade e antecipa as esperas quando ela responde 107; (2) drena TODOS os itens vencidos de cada empresa, isoladas por try, ate 50 por passada, com o adapter da procedencia (adapterDaFila: nota de ensaio so pelo simulador e nunca com operacao/nota/processo em producao - item parado com CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION; nota assinada de verdade so pelo SefazRealAdapter com o A1 do cofre da propria empresa; sem A1 a nota ESPERA sem gastar tentativa, com o motivo no item); (3) para a empresa na primeira indisponibilidade. FiscalFilaPainel: painel da fila (trabalhador, ultima sondagem, contagens, itens com motivo, pendencias) e transmitirAgora (uma nota, inclusive a de contingencia, que volta com o mesmo numero e chave). Rotas GET /fiscal/queue, POST /fiscal/queue/drain, POST /fiscal/documents/:id/transmitir (gerencia; o caixa recebe 403). Pendencia TRANSMISSION_DELAYED (na fila ha mais de 30 min, com o motivo). statusServico ganhou model opcional (host da NFC-e no RS). Tela: quadro "Transmissao a SEFAZ" em Fiscal > Documentos, "Transmitir agora"/"Devolver a fila e transmitir" no detalhe, e "Nova tentativa automatica as..." no PDV. |
| DEPOIS | FiscalQueueWorker é ligado no index.ts (setInterval com unref, sem passadas sobrepostas). Ele sonda a SEFAZ, antecipa as esperas quando ela volta e drena todos os itens vencidos de cada empresa, isoladas entre si, até 50 por passada. A emissão agora transmite só a nota da própria venda. Há painel, drenar, transmitir agora e devolver da contingência na tela, a pendência TRANSMISSION_DELAYED e a próxima tentativa mostrada no PDV. |
| Arquivos | server/src/services/core/FiscalQueueWorker.ts, server/src/services/core/FiscalFilaPainel.ts, server/src/services/core/FiscalQueueService.ts, server/src/services/core/FiscalPipelineService.ts, server/src/services/core/FiscalContingencyService.ts, server/src/services/core/SefazAdapter.ts, server/src/services/core/SefazRealAdapter.ts, server/src/services/core/SefazTestAdapter.ts, server/src/index.ts, server/src/routes/v1/core.ts, server/tests/fiscal-fila-autonoma.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/filaFiscal.ts, src/components/gs/FilaFiscal.tsx, src/pages/gs/FiscalDocumentosPage.tsx, src/components/gs/PainelFiscalPdv.tsx, src/lib/api/core.ts, src/components/gs/__tests__/filaFiscalNaTela.test.tsx |
| COMMIT | 9f63d77, d7a3a13 |
| TESTES | server/tests/fiscal-fila-autonoma.test.ts (22 casos): a venda nova não transmite a nota velha; drena todas as vencidas de duas empresas; respeita o backoff; recupera item travado; para na indisponibilidade sem segurar a vizinha; usa o ambiente da nota; sondagem 107 antecipa; sem A1 espera sem gastar tentativa; com A1 sai pelo adapter real; nota de ensaio em produção fica parada; painel; caixa leva 403; transmitir agora; volta da contingência; 404 de outra operação; start/stop; index.ts. Tela: filaFiscalNaTela.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/FiscalQueueWorker.ts:155-188, 461-567, 595-657, 693-704; server/src/index.ts:210; server/src/services/core/FiscalPipelineService.ts:450-456, 484-489; server/src/services/core/FiscalQueueService.ts:252-286, 460; server/src/routes/v1/core.ts:8128, 8149-8182 (gerência, companyId do token); src/components/gs/FilaFiscal.tsx:71,201; src/pages/gs/FiscalDocumentosPage.tsx:618-632; src/components/gs/PainelFiscalPdv.tsx:390; server/src/services/core/FiscalContingencyService.ts:480 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Nenhum insumo para a fila. A transmissao real depende do A1 com a senha selada no cofre (GAP-PRD-023, FIS/F5) e da homologacao na SVRS - nenhuma linha de codigo da fila depende disso. |

### GAP-PRD-021 — Substituição tributária (CSOSN 201/202/203/500/900) e regime normal (ICMS por CST) não são emitidos; CRT 3 é aceito no cadastro e no checklist

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | PJ Motors, Oficina (autopeças = ST), Me Mimei (cosméticos = ST); qualquer empresa fora do Simples / FIS |
| ANTES | Só os CSOSN 101/102/103/300/400 eram emitidos. CSOSN 500/900 e todo CST de ICMS eram recusados só na venda, e o CRT 3 era aceito no cadastro e no checklist. |
| Causa | O bloco <imposto> nao tinha os grupos ICMSSN500/900 nem ICMS00/20/40/60/90, nem vinculo aliquota de ICMS <-> grupo tributario (kind icms tinha sido retirado por nao ter leitor); o CRT era texto livre e o MEI (CRT 4) caia no ramo do regime normal. |
| Correção | TabelasDoIcms (modulo sem dependencias): CSOSN e CST de ICMS da tabela do leiaute, o que a emissao monta, o que recusa (ST calculada pelo emitente, cobrada por fora: CSOSN 201/202/203 e CST 10/30/70; combustivel e diferimento: 02/15/51/53/61), CRT 1-4 (1, 2 e 4 pelo CSOSN), formato do cBenef e percentual de 2 a 4 casas. TributacaoDoItem: ICMS proprio dos CST 00/20/90 com modBC 3, base (com reducao obrigatoria no 20 e opcional no 90), aliquota de core_tax_rates kind icms pelo icms_rate_code do grupo e FCP (kind fcp, fcp_rate_code), tudo arredondado por item; CSOSN 900 com pCredSN quando o grupo declara; cBenef do grupo; recusa da ST por fora com a razao e o caminho (CSOSN 500/CST 60 para ST ja recolhida). impostoXml monta ICMSSN500/900 e ICMS00/20/40/60/90 na ordem do XSD; totaisDoIcms alimenta vBC/vICMS/vFCP do ICMSTot nos dois modelos; cBenef no <prod> antes do CFOP. Cadastro do grupo confere CSOSN, CST, aliquota de ICMS (existe, ativa, CST que a le), reducao (0-100, CST 20/90), FCP (exige ICMS) e cBenef; INSERT passa a usar a mesma lista do UPDATE. kinds icms e fcp voltam ao cadastro de aliquotas. updateFiscalConfig recusa CRT fora de 1-4 (CORE_FISCAL_CRT_INVALID); o item crt do checklist fica DIVERGENTE com CRT herdado fora do leiaute. DDL: core_tax_groups ganha icms_rate_code, p_red_bc, fcp_rate_code, c_benef (anulaveis). Telas: CRT como seletor dos quatro valores com aviso do regime normal; CSOSN e CST de ICMS como seletores da tabela; aliquota de ICMS, reducao, FCP e cBenef no grupo, limpos quando o CST nao os le, com avisos do que a emissao recusa. |
| DEPOIS | ICMSSN500/900 e ICMS00/20/40/60/90 saem com base, alíquota do grupo, redução, FCP, modBC 3 e cBenef, e somam no ICMSTot. A ST calculada pelo emitente (CSOSN 201/202/203, CST 10/30/70) é recusada com a razão, no cadastro, no checklist e na emissão. O CRT só aceita 1 a 4, e a tela usa um seletor com aviso para o regime normal. |
| Arquivos | server/src/services/core/TabelasDoIcms.ts, server/src/services/core/TributacaoDoItem.ts, server/src/services/core/CatalogAuxService.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/core/FiscalXmlNfce.ts, server/src/services/core/FiscalXmlNfe.ts, server/src/db/schema.ts, server/tests/icms-da-st-e-do-regime-normal.test.ts, server/tests/pis-cofins-tem-leitor.test.ts, src/lib/api/core.ts, src/pages/gs/FiscalPage.tsx, src/pages/gs/AuxiliaresCatalogoPage.tsx, src/pages/gs/__tests__/auxiliaresIcmsDoGrupo.test.tsx, src/pages/gs/__tests__/auxiliaresGrupoTributario.test.tsx, src/pages/gs/__tests__/fiscalCrtEProntidaoTributaria.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | bdeaa93, a0d4556 |
| TESTES | server/tests/icms-da-st-e-do-regime-normal.test.ts: 500/900 no XSD nos dois modelos; 201/202/203 e CST 10/30/70 recusados com a razão; CST 00/20/40/60/90 com base e valor; FCP; CRT 4; CRT fora de 1-4 recusado; cBenef. server/tests/prontidao-enxerga-o-grupo-tributario.test.ts: o checklist nomeia regime normal sem alíquota e CSOSN 201. Tela: auxiliaresIcmsDoGrupo e fiscalCrtEProntidaoTributaria. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/TabelasDoIcms.ts:33-81; server/src/services/core/TributacaoDoItem.ts:510-588, 1100-1203; server/src/services/core/FiscalConfigService.ts:185-204 (CORE_FISCAL_CRT_INVALID), 559-575 (item crt); src/pages/gs/FiscalPage.tsx:1513-1625 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Contador: CRT de cada CNPJ; quais mercadorias são ST e se a ST vem retida (CSOSN 500/CST 60); para o regime normal, CST, alíquota, redução, FCP e cBenef por grupo. Riscos declarados, não comprovados: se alguma empresa for substituta (201/202/203), é trabalho novo; se a SEFAZ-RS exigir vBCSTRet/pST/vICMSSTRet na NFC-e, faltam essas colunas. |

### GAP-PRD-022 — CSC: um slot por unidade sem conferência de ambiente — operação em produção usa o CSC de homologação em silêncio; gravar CSC de produção exige NFCE_PRODUCTION_ENABLED + reinício

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas as seis / FIS |
| ANTES | Havia um CSC por unidade, sem ambiente. Em produção, o QR usava o CSC de homologação em silêncio. Gravar o de produção exigia NFCE_PRODUCTION_ENABLED e reinício. |
| Causa | CSC modelado como um valor por unidade, sem ambiente; a trava de producao posta na gravacao (variavel de processo) em vez de no uso (ambiente da operacao, que ja tem desbloqueio auditado). |
| Correção | NfceCscService: chave (empresa, unidade, ambiente), lista fechada de ambientes (400 NFCE_CSC_ENVIRONMENT_INVALID), documento antigo sem environment lido como homologacao, sem a variavel NFCE_PRODUCTION_ENABLED (continua so no modulo legado NfceService), cscsDaOperacao (ID e data por ambiente, sem token), acharCscDaOperacao/getNfceCscToken com ambiente obrigatorio. exigirCscDaOperacao(empresa, ambiente) recusa NFCE_CSC_REQUIRED nomeando os dois ambientes e o ID que existe quando so ha o do outro; conferirExigenciasDaMontagem (antes de numerar), buildNfceXml e aplicarQrOffline usam o ambiente da operacao/nota com o fail-safe do tpAmb. Prontidao: item csc PASS so com o do ambiente (known com ID e ambiente; em homologacao avisa se o de producao falta), FAIL DIVERGENTE com o do outro, FAIL PENDENTE sem nenhum; PASSOS_RESTANTES do desbloqueio diz que o de producao pode ser gravado antes. POST /fiscal/nfce/csc passa o ambiente cru ao servico e audita fiscal.nfce_csc.upsert (ambiente, ID, unidade; nunca o token); /integrations/nfce/secrets aceita environment. Tela: o cartao do CSC lista homologacao e producao com o ID de cada um e qual o cupom usa hoje, alerta quando a operacao emite num ambiente cujo CSC nao existe e o do outro sim, e tem o seletor de ambiente (comeca no da operacao) com a frase de que o de producao fica guardado ate a virada. |
| DEPOIS | O CSC agora é chaveado por empresa, unidade e ambiente, com lista fechada de ambientes. A variável não é mais exigida. Montagem, pré-validação e QR offline usam o CSC do ambiente da operação ou da nota, e a recusa nomeia os dois ambientes. O checklist dá FAIL DIVERGENTE quando só existe o CSC do outro ambiente. O POST é auditado sem o token. O cartão da tela mostra os dois ambientes e deixa gravar o de produção antes da virada. |
| Arquivos | server/src/services/nfce/NfceCscService.ts, server/src/services/core/FiscalXmlNfce.ts, server/src/services/core/NfceQrOffline.ts, server/src/services/core/FiscalDocumentService.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/nfce/NfceService.ts, server/src/routes/v1/nfce.ts, server/src/routes/v1/integrations.ts, server/tests/csc-por-ambiente.test.ts, server/tests/a-emissao-abre-o-cofre.test.ts, src/pages/gs/FiscalPage.tsx, src/lib/api/core.ts, src/pages/gs/__tests__/fiscalCscPorAmbiente.test.tsx, src/pages/gs/__tests__/fiscalNumeracaoECsc.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | ae29403, 65eefe4 |
| TESTES | server/tests/csc-por-ambiente.test.ts: gravar o de produção não apaga o de homologação; grava sem variável; resumo sem token; registro antigo vale homologação; ambiente inválido recusado; produção só com o de homologação é recusada antes de numerar; QR de produção com o CSC de produção; checklist DIVERGENTE/PASS; POST auditado sem o token. Tela: fiscalCscPorAmbiente. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/nfce/NfceCscService.ts:46-108, 121-172; server/src/services/core/FiscalXmlNfce.ts:402-432, 514, 718; server/src/services/core/NfceQrOffline.ts:96; server/src/services/core/FiscalConfigService.ts:424-475; server/src/routes/v1/core.ts:4483-4505; src/pages/gs/FiscalPage.tsx:732-795 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Emanuel: CSC ID e token de homologação e de produção de cada CNPJ que emite NFC-e, tirados do portal da SEFAZ-RS e gravados em Fiscal > Configuração. Observação sem efeito na emissão: server/src/services/system-admin/CoreProductionReadinessService.ts:49 ainda lista NFCE_PRODUCTION_ENABLED como chave informativa do painel de sistema. |

### GAP-PRD-023 — Certificado real do dono gravado antes da autodetecção: senha NÃO selada, cartão sem titular/conferência — PDV pararia em FISCAL_CERTIFICATE_PASSWORD_REQUIRED; vence em 15/10/2026

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Preço Justo (única com certificado); as outras cinco não têm certificado, config, série, CSC nem grupo / FIS |
| ANTES | O A1 da Preço Justo foi gravado sem a senha selada, e o cartão não tinha titular nem conferência. O PDV pararia em FISCAL_CERTIFICATE_PASSWORD_REQUIRED, e a tela não dizia o que fazer. |
| Causa | O dado real e externo (certificado gravado antes da senha selada; so o dono tem a senha). O que era codigo: a prontidao nao olhava a senha selada e a tela nao instruia o reenvio; a frase certa so aparecia como erro na hora da venda. |
| Correção | Servidor: item certificate FAIL/PENDENTE (dono) quando o certificado existe e a senha nao esta selada, com a instrucao do reenvio (mesmo .pfx com a senha em Fiscal > Certificado) no detalhe e o titular lido do arquivo no known; a operacao volta a READY_FOR_CERTIFICATE; o reenvio pelo caminho de sempre sela a senha, preenche o cartao, confere o CNPJ e devolve o PASS (provado). Tela: CertificadoValidado mostra o aviso aberto (fora dos detalhes tecnicos) com o que para e o gesto que resolve, marca CERTIFICADO COM PENDENCIA e o detalhe diz "nao - reenvie o arquivo com a senha"; a lista do grupo (CertificadoPage) ganha a coluna Senha no cofre (NAO SELADA - REENVIE) e conta o caso como atencao. A recusa da emissao (FISCAL_CERTIFICATE_PASSWORD_REQUIRED, documento aguardando sem queimar numero) ja existia e segue coberta por a-emissao-abre-o-cofre. |
| DEPOIS | O item certificate do checklist dá FAIL/PENDENTE (dono) com a instrução de reenvio. O cartão mostra um aviso aberto e o selo CERTIFICADO COM PENDÊNCIA, e a lista do grupo mostra NÃO SELADA — REENVIE. O reenvio pelo POST /fiscal/certificate sela a senha. Nenhuma linha falta: basta Emanuel reenviar o .pfx com a senha. |
| Arquivos | server/src/services/core/FiscalConfigService.ts, server/tests/certificado-sem-senha-selada.test.ts, src/components/gs/CertificadoValidado.tsx, src/pages/gs/CertificadoPage.tsx, src/pages/gs/__tests__/certificadoSemSenhaSelada.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | 8454c0d |
| TESTES | server/tests/certificado-sem-senha-selada.test.ts: o registro real do dono não é PASS e manda reenviar; a NF-e diz o mesmo; a operação não se diz pronta; a lista mostra um booleano, nunca a senha; reenviar o mesmo .pfx sela a senha, preenche o cartão, confere o CNPJ e volta ao PASS. Tela: certificadoSemSenhaSelada. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/FiscalConfigService.ts:596-625; server/src/services/fiscal/FiscalCertificateService.ts:426, 457 (sela encryptedPassword no upload), 516, 579; server/src/routes/v1/core.ts:4342; src/components/gs/CertificadoValidado.tsx:118-135, 150-172, 227-229; src/pages/gs/CertificadoPage.tsx:188, 266-269 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel: (1) reenviar o .pfx do A1 da Preço Justo com a senha em Fiscal > Certificado > Substituir; (2) renovar esse A1 antes de 15/10/2026 e enviar pelo mesmo caminho; (3) mandar o A1 de cada uma das outras cinco empresas. Não verifiquei o banco da loja (proibido ou dispensável). |

### GAP-PRD-024 — A venda gerada pelo checkout da OS não tem caminho fiscal (serviço sem NFS-e; linha sem produto/NCM; peças não itemizadas)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | Oficina, Preço Justo (celulares) / FIS |
| ANTES | O checkout da OS criava uma linha única 'Ordem de serviço #N' sem produto. A NFC-e recusava por NCM/CFOP/origem, e não havia NFS-e. |
| Causa | O checkout juntava peca (mercadoria, ICMS) e mao de obra (servico, ISS) numa linha sem produto, e o sistema so tinha documento de mercadoria. |
| Correção | Mercadoria: VendaDaOficina.vendaDaOs itemiza a OS (pecas liquidas da devolucao, preco da OS, retrato de custo; mao de obra) e recusa OS cuja conta nao fecha (409 CORE_ORDER_TOTAL_MISMATCH); createSale ganhou linhasJaBaixadas (linha com produto e custo, sem movimento de estoque); o checkout cria a venda itemizada. FiscalVendaDaOficina.separarMercadoriaDeServico (em loadSaleForNfce: NFC-e, NF-e, DANFCE, prontidao) deixa so as pecas na nota, rateia o pagamento (troco sai do dinheiro, fecha no centavo), itemiza pela propria OS a venda antiga de linha unica, e recusa desconto/acrescimo no total de venda mista (regra do contador). Venda so de servico: a nota de mercadoria diz que o documento e a NFS-e. Servico: core_nfse_configs (modo DESLIGADA padrao \| EMISSOR_NACIONAL \| REGISTRO_MANUAL; codigos do contador; municipio confirmado; serie/numero da DPS) e core_nfse_documents (uma por venda); NfseDps monta e valida a DPS 1.00 antes do numero; NfseAdapter com NfseNacionalAdapter (POST JSON GZip+Base64 a Sefin Nacional por TLS mutuo, raizes publicas + ICP-Brasil, transporte injetavel, leitura de chave/NFS-e/erros) e NfseTesteAdapter (recusado com operacao ou processo em producao); NfseService: prontidao com dono de cada pendencia, emissao assinada com o A1 do cofre, idempotente, reenvio com o MESMO numero apos recusa ou queda, producao so apos autorizacao real na homologacao, registro do portal e registro de cancelamento com auditoria; rotas em routes/v1/nfse.ts montadas no coreRouter. Telas: DocumentosFiscaisDaOs na OS paga (pecas pelas rotas da NFC-e do PDV; NFS-e emitir/tentar de novo/registrar; motivos sem botao) e NfseConfigCard em Fiscal > Configuracao. |
| DEPOIS | O checkout itemiza a OS: as peças viram linhas com produto e custo, sem nova baixa, e a mão de obra vira serviço. Uma OS cuja conta não fecha é recusada com 409. A NFC-e sai só com as peças, com o pagamento rateado. A NFS-e tem três modos por configuração: DESLIGADA (padrão), REGISTRO_MANUAL e EMISSOR_NACIONAL (DPS assinada com o A1 do cofre, enviada à Sefin). A OS paga e Fiscal > Configuração têm tela, e as rotas pegam o companyId do token. |
| Arquivos | server/src/db/schema.ts, server/src/services/core/VendaDaOficina.ts, server/src/services/core/FiscalVendaDaOficina.ts, server/src/services/core/NfseDps.ts, server/src/services/core/NfseAdapter.ts, server/src/services/core/NfseService.ts, server/src/routes/v1/nfse.ts, server/src/routes/v1/core.ts, server/src/services/core/SalesService.ts, server/src/services/core/FiscalXmlNfce.ts, server/src/services/core/FiscalXmlNfe.ts, server/tests/a-os-tem-caminho-fiscal.test.ts, server/tests/nfse-da-mao-de-obra.test.ts, server/tests/audit-workshop.test.ts, src/lib/api/nfse.ts, src/components/gs/DocumentosFiscaisDaOs.tsx, src/components/gs/NfseConfigCard.tsx, src/pages/gs/OrdemServicoPage.tsx, src/pages/gs/FiscalPage.tsx, src/components/gs/__tests__/documentosFiscaisDaOs.test.tsx, src/components/gs/__tests__/nfseConfigCard.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | 1ae62eb, 98aa116 |
| TESTES | server/tests/a-os-tem-caminho-fiscal.test.ts: venda itemizada com custo e sem nova baixa; peça devolvida fica fora; conta que não fecha é recusada; NFC-e só com as peças, no XSD, com rateio; OS só de serviço aponta para a NFS-e; venda antiga itemizada pela OS. server/tests/nfse-da-mao-de-obra.test.ts: padrão desligado; 403/400/auditoria; DPS assinada; mesmo número no reenvio; simulador recusado com NODE_ENV=production; produção travada até autorização real; registro manual e cancelamento; tenant. Tela: documentosFiscaisDaOs e nfseConfigCard. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/WorkshopCashierService.ts:311-333; server/src/services/core/VendaDaOficina.ts:54, 102; server/src/services/core/FiscalVendaDaOficina.ts:136; server/src/services/core/FiscalXmlNfce.ts:227; server/src/services/core/NfseService.ts:52-53, 353-373, 821; server/src/services/core/NfseAdapter.ts:63-64; server/src/routes/v1/nfse.ts:45-134; server/src/routes/v1/core.ts:10094-10124, 16573; src/pages/gs/OrdemServicoPage.tsx:1799; src/pages/gs/FiscalPage.tsx:149 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Dono: escolher o modo da NFS-e (o Registro manual funciona já, sem código). Contador: cTribNac, situação no Simples, apuração, retenção e alíquota do ISS. Prefeitura: confirmar a adesão ao Sistema Nacional NFS-e. Emanuel: A1 com senha selada e primeira DPS em produção restrita. Riscos declarados: a DPS 1.00 foi escrita sem o XSD oficial (a homologação é o juiz), e o cancelamento pela API da Sefin não existe (é feito no portal e registrado no sistema). |

### GAP-PRD-025 — Pré-venda/orçamento de moto serializada NÃO converte em venda: convertQuote não passa unitIds e o funil recusa com CORE_UNITS_REQUIRED

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | PJ Motors (e qualquer empresa com produto serialized=1: celulares da Preço Justo) / OFI |
| ANTES | convertQuote mandava os itens a createSale sem unitIds, e toda conversão de pré-venda ou orçamento de moto serializada caía com 400 CORE_UNITS_REQUIRED. A reserva ficava presa. |
| Causa | a conversao nao escolhia qual unidade sai, e o funil do estoque, por desenho, nao escolhe sozinho |
| Correção | UnitHoldService.resolverUnidadesDaConversao: o chassi bipado na conversao (corpo unidades [{productId, unitIds}], conferido na forma por lerUnidadesPedidas e na quantidade do documento), senao a moto que o documento segura, senao FIFO a vista entre as livres; convertQuote passa unitIds por item a createSale e solta as reservas do documento na mesma transacao (rollback devolve tudo); PDV: loadQuote poe o chassi na linha (a segurada primeiro, depois a livre mais antiga), bipar outro chassi troca a moto da linha em vez de somar, e a conversao manda unidadesDaConversao(lines); orcamento de moto tambem converte |
| DEPOIS | A conversão escolhe a unidade nesta ordem: o chassi bipado no corpo 'unidades', depois a moto que o documento segura, depois FIFO entre as livres. Quantidade e produto são conferidos, as reservas são soltas na mesma transação e o PDV manda o chassi da linha. |
| Arquivos | server/src/services/core/UnitHoldService.ts, server/src/services/core/QuoteService.ts, server/src/routes/v1/core.ts, src/pages/gs/PdvPage.tsx, src/lib/api/motoDaPreVenda.ts, src/lib/api/core.ts, server/tests/moto-da-pre-venda.test.ts, src/pages/gs/__tests__/motoDaPreVenda.test.tsx |
| COMMIT | ae93817 |
| TESTES | server/tests/moto-da-pre-venda.test.ts bloco GAP-PRD-025 (4): conversão sem escolha sai por FIFO com 201 e reserva zerada; o chassi bipado sai; quantidade errada dá CORE_UNITS_REQUIRED, produto fora do documento dá CORE_QUOTE_UNITS_WRONG_PRODUCT, unidade já vendida dá 409, e nada anda; orçamento também converte. src/pages/gs/__tests__/motoDaPreVenda.test.tsx bloco GAP-PRD-025 (3): o corpo da conversão leva unitIds da linha. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/core/UnitHoldService.ts:217-313 (lerUnidadesPedidas, resolverUnidadesDaConversao); server/src/services/core/QuoteService.ts:1365-1374 e 1455 (unitIds por item); server/src/routes/v1/core.ts:5063; src/lib/api/motoDaPreVenda.ts:60-77; src/pages/gs/PdvPage.tsx:1671 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-026 — Chassi/série/IMEI da unidade vendida não sai em NENHUM documento fiscal nem no cupom — só <xProd>; sem infAdProd nem veicProd

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | PJ Motors (motos/ciclomotores/patinetes), Preço Justo (celulares por IMEI) / FIS |
| ANTES | O chassi, a série e o IMEI da unidade vendida não saíam em nenhum XML nem no papel. O sale_item_id nem era gravado. |
| Causa | A identidade da unidade existia so no estoque: a venda nao ligava a unidade a linha, e nenhum montador de XML nem renderizador de papel lia core_product_units. |
| Correção | SalesService carimba sale_item_id na unidade de cada linha (mesma transacao da baixa). IdentidadeDaUnidadeFiscal.unidadesPorLinha e o leitor unico: pela linha; sem carimbo (venda antiga) ou pedido online, pela saida (exit_reference sale/ecommerce_order) quando a linha do produto e unica. loadSaleForNfce e orderAsFiscalOperation levam as unidades; NF-e e NFC-e emitem <infAdProd> (Chassi, Motor, Serie, IMEI, Placa) depois do <imposto>, dentro do XSD oficial; identidade acima de 500 caracteres e recusada em validateNfce/validateNfe (antes do numero e na prontidao da venda) dizendo o caminho; cupom da venda, DANFCE e DANFE imprimem a identidade; cabecalhos de ProductUnitService e EquipmentStockLink corrigidos. |
| DEPOIS | A venda carimba sale_item_id na unidade de cada linha. Um leitor único busca as unidades pela linha ou, na venda antiga, pela saída. NFC-e e NF-e emitem <infAdProd> (Chassi/Motor/Série/IMEI/Placa) depois do <imposto>. Uma identidade com mais de 500 caracteres é recusada antes do número. Cupom, DANFCE e DANFE imprimem a identidade, e o cabeçalho do ProductUnitService foi corrigido. |
| Arquivos | server/src/services/core/IdentidadeDaUnidadeFiscal.ts, server/src/services/core/SalesService.ts, server/src/services/core/FiscalXmlNfce.ts, server/src/services/core/FiscalXmlNfe.ts, server/src/services/core/OrderInvoiceService.ts, server/src/services/core/PrintRenderer.ts, server/src/services/core/DanfceRenderer.ts, server/src/services/core/DanfeRenderer.ts, server/src/services/core/ProductUnitService.ts, server/src/services/core/EquipmentStockLink.ts, server/tests/a-unidade-sai-no-documento.test.ts, server/tests/audit-pjmotors.test.ts |
| COMMIT | a9d634e, 7b44c3e |
| TESTES | server/tests/a-unidade-sai-no-documento.test.ts (10 casos): carimbo por linha; mesmo produto em duas linhas com o chassi certo em cada; venda antiga achada pela saída; infAdProd na NFC-e e na NF-e pelo XSD oficial; IMEI só na linha do celular; sem identidade não inventa infAdProd; 30 IMEIs recusados antes do número; cupom, DANFCE e DANFE com o chassi. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/SalesService.ts:1756-1767, 1890-1905; server/src/services/core/IdentidadeDaUnidadeFiscal.ts:90-135, 188-217; server/src/services/core/FiscalXmlNfce.ts:204, 242, 329-332, 638-639; server/src/services/core/FiscalXmlNfe.ts:209-212, 360; server/src/services/core/PrintRenderer.ts:266-280; server/src/services/core/DanfceRenderer.ts:200-202; server/src/services/core/DanfeRenderer.ts:104-124; server/src/services/core/ProductUnitService.ts:41-50 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A ficha aceita infAdProd como mínimo, e isso foi entregue. Pergunta ao contador: a moto nova precisa de NF-e com o grupo veicProd (dados RENAVAM)? Se sim, é trabalho novo (ficha do veículo, veicProd e NF-e de balcão com destinatário estruturado) que não foi implementado. |

### GAP-PRD-027 — Login Google (OAuth2/OIDC) não existe — nem rota, nem adapter, nem botão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | todas / ECO |
| ANTES | Não havia login Google: nem rota, nem cliente OIDC, nem conta sem senha, nem botão. |
| Causa | Ausencia de implementacao: nenhum cliente OIDC, nenhuma configuracao para o cliente OAuth do dono, nenhuma forma de conta sem senha, nenhuma tela. |
| Correção | Servidor: OidcClient (Authorization Code + PKCE S256, state, nonce, troca do codigo com o segredo, id_token RS256 conferido contra o JWKS com emissor/audiencia/azp/exp/iat/nonce, alg none e HS256 recusados, cache de chaves com releitura no kid novo e teto de releitura forcada). GoogleLoginService: pedido em voo em core_portal_google_states (impressao SHA-256 do state e da chave do navegador contra login CSRF, verificador PKCE apagado no uso, uso unico atomico, 10 min), e-mail verificado exigido, identidade (emissor, sub) em core_customer_identities, vinculo com a conta de mesmo e-mail (provada: liga e avisa o dono pelo e-mail google_ligado; nunca provada: assumida como na recuperacao de senha - senha morre, sessoes caem, CPF declarado sem prova sai), conta nova sem senha com aceite dos termos (ticket de uso unico quando o aceite nao veio no comeco), ligar/desligar na conta aberta sem deixar conta sem porta, trilha do cliente em core_audit_log (company_id nulo), sessao do portal pela mesma abrirSessao (CustomerPortalService.abrirSessaoPorIdentidadeProvada, com syncLinks do e-mail provado). Nenhuma senha nem token do Google e guardado. Conta sem senha: core_customer_accounts.has_password (DEFAULT 1) + marcador que nunca confere em password_hash; login por senha recusa com a mesma resposta generica; troca de senha 409 PORTAL_CONTA_SEM_SENHA; a recuperacao da a primeira senha (has_password=1); perfil devolve hasPassword. Configuracao da INSTALACAO em core_portal_google_login (Client ID validado, segredo selado com o cofre e registrado em secretsInventory.LUGARES para a rotacao, redirect URI https/localhost terminando em /minha-conta/google), GET/PUT /core/portal/login-google com requireProfile(req) (admin_geral/gestor) e trilha antes/depois sem segredo. Adapter fake: ProvedorGoogleDeTeste (consentimento, token com PKCE e uso unico, JWKS com chave RSA em memoria, emissor .invalid), selecionavel por configuracao e recusado em producao/homologacao/NODE_ENV=production na gravacao, na execucao (banco copiado) e nas rotas de consentimento (404). Tela: EntrarComGoogle na tela de entrar/criar (so aparece quando ligado; o de teste se declara), RetornoDoGooglePage em /minha-conta/google (code+state+chave da aba, uma vez; recusa, erro e aceite dos termos), GoogleNaConta em Minha conta (ligar/desligar), ContaDoCliente troca Trocar senha pelo caminho da recuperacao na conta sem senha, LoginGooglePage em /sistema/integracoes/google (donos do grupo) com situacao, o que falta, segredo que nao volta e redirect URI sugerido. |
| DEPOIS | Há OIDC completo: Authorization Code + PKCE S256, state, nonce, id_token RS256 contra o JWKS do Google, e-mail verificado exigido, vínculo e conta sem senha. O modo Google usa os endpoints reais via fetch, a configuração se grava pela tela dos donos com o segredo selado, e o provedor de teste é recusado em produção e homologação. Se Emanuel colar o Client ID e o segredo, nenhuma linha falta. |
| Arquivos | server/src/services/core/OidcClient.ts, server/src/services/core/GoogleLoginService.ts, server/src/services/core/GoogleLoginConfigService.ts, server/src/services/core/ProvedorGoogleDeTeste.ts, server/src/services/core/CustomerPortalService.ts, server/src/services/core/CustomerAccountService.ts, server/src/services/notifications/EmailService.ts, server/src/routes/v1/storefront.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, server/src/db/secretsInventory.ts, server/tests/login-google-oidc.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/loginGoogle.ts, src/components/gs/EntrarComGoogle.tsx, src/components/gs/GoogleNaConta.tsx, src/components/gs/ContaDoCliente.tsx, src/pages/gs/RetornoDoGooglePage.tsx, src/pages/gs/LoginGooglePage.tsx, src/pages/gs/MinhaContaPage.tsx, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, src/components/gs/__tests__/entrarComGoogle.test.tsx, src/pages/gs/__tests__/loginGooglePage.test.tsx, src/pages/gs/__tests__/MinhaContaPage.test.tsx, src/router/__tests__/environments.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 34e7345, f6c8553 |
| TESTES | server/tests/login-google-oidc.test.ts: PKCE, state, nonce, replay, login CSRF, e-mail não verificado, conta assumida, conta sem senha, ligar/desligar, configuração só dos donos, segredo fora da resposta e da trilha. No modo Google com transporte dublado: accounts.google.com, troca com segredo+PKCE, rotação de kid, Google fora do ar 502. Provedor de teste recusado em produção (:837+). Tela: entrarComGoogle.test.tsx e loginGooglePage.test.tsx. Rodado: verde. A volta real pelo Google não foi verificada: exige a credencial e chamada externa, ambas vetadas. |
| EVIDÊNCIA | server/src/services/core/GoogleLoginConfigService.ts:41-47 (endpoints accounts.google.com, oauth2.googleapis.com/token, googleapis.com/oauth2/v3/certs) e 335-375 (configuracaoEmUso decifra o segredo e escolhe os endpoints reais); GoogleLoginService.ts:109-111 (transporteDoGoogle); OidcClient.ts:70-88 (fetch real); core.ts:16025-16060 (GET/PUT /core/portal/login-google, requireProfile, trilha sem segredo); storefront.ts:1565 e 1581 (iniciar/concluir); ProvedorGoogleDeTeste.ts:49-64 (recusa em production/staging/NODE_ENV=production); src/router/gsRoutes.tsx:193 (/minha-conta/google) e 647 (/sistema/integracoes/google); navItems.ts:953-956 ('Entrar com Google (loja)'); MinhaContaPage.tsx:644 e 888. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel: criar no Google Cloud Console um ID de cliente OAuth tipo Aplicativo da Web, com tela de consentimento publicada (openid, email, profile) e URI de redirecionamento = endereço público da loja + /minha-conta/google. Depois colar Client ID e segredo em Sistema > Integrações > 'Entrar com Google (loja)', escolher modo Google e ligar. Pressupõe GRUPO_SAMPAIO_PUBLIC_URL definido e a chave do cofre que sela os segredos já configurada na instalação (não verifiquei no ambiente real). |

### GAP-PRD-028 — Conta não é exigida para comprar; checkout ignora perfil e endereços salvos; 'cadastro incompleto' não bloqueia; vincular pedidos exige rota sem botão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | todas as lojas / INT |
| ANTES | Comprar não exigia conta, o checkout ignorava perfil e endereços salvos, 'cadastro incompleto' não bloqueava, e vincular pedidos exigia rota sem botão. |
| Causa | Verificação adversarial do R3-IBGE: municipioDaNotaQueNaoConfere conferia só código × UF, então um código válido de outra cidade da UF passava (a SEFAZ não confere o nome e autoriza); problemaDoMunicipioDoCadastro comparava a cidade do emitente por igualdade estrita, e a UF escrita no fim ("Macapá - AP", o exemplo que o próprio conserto deu) virava FAIL no portão de montagem; corrigirMunicipioDaNotaDoPedido só aceitava município da UF do endereço, e o dado da 84 pode ter a UF errada com o código certo. \|\| Antes: O IBGE-MUNICIPIOS fez valer a tabela ao salvar o endereço e no fechamento, mas não na EMISSÃO: orderInvoiceReadiness/createNfeForOrder (e createNfeForSale) só conferiam os 7 dígitos do cMun (validateRecipient), e o retrato do pedido fechado antes da tabela (congelado pelo GAP-PRD-115) não tinha caminho de correção; o cadastro fiscal do emitente (updateFiscalConfig) não conferia o código e o checklist (item ibge) só olhava o formato — um cMun errado no emitente vai em toda NF-e, NFC-e e no Id da DPS. \|\| Antes: O IBGE-MUNICIPIOS fez valer a tabela ao SALVAR o endereço e, no fechamento, só no endereço de ENTREGA (conferirEntregaDaConta, e só quando alguma loja entrega). O endereço de faturamento — escolhido (enderecoDoCheckout "faturamento") ou o padrão da conta (faturamentoPadraoDaConta) — ia para o retrato billing_* sem ser conferido; endereço salvo antes da tabela (o banco da 84 tem esses) com um código digitado errado entrava no pedido pago, e a NF-e saía com um cMun que não existe, recusada pela SEFAZ depois de numerada. A reauditoria do GAP-PRD-028 passou a exigir o código IBGE para ENTREGAR, mas o sistema não tinha como tirar o código do nome da cidade: sem tabela de municípios, o formulário só podia pedir o número ao cliente — que não sabe o que é isso, e a compra não fechava. |
| Correção | Verificação (a0b0be7): MunicipiosIbge — municipioDaNotaQueNaoConfere(codigo, uf, cidade) aponta também o código da UF cuja cidade escrita é, sem dúvida, OUTRA cidade da UF (municipioPeloNome acha uma só com esse nome); nome abreviado, com erro ou com a UF no fim não contradiz nada; mesmaCidadeEscrita aceita o nome do município com a UF DELE no fim ("- RS", "/RS", "(RS)", ", RS"; a UF de outro estado não passa), usada no cadastro do emitente (422), no checklist (item ibge), na NFS-e e na conferência da implantação; municipioPeloNome também enxerga "Pelotas - RS". OrderInvoiceService: a prontidão, a emissão (recusa sem numerar) e o "já confere" da correção passam a cidade escrita; a prontidão traz doCodigo (o município do próprio código quando ele é de outra UF) e a frase diz que, se o cliente é de lá, a UF é que está errada; a correção aceita o município do PRÓPRIO código do cliente trocando a UF para a dele — nenhuma outra saída de UF —, grava billing_state/shipping_state junto, e o histórico do pedido e a auditoria (ufDe, ufPara) dizem de qual UF para qual. FiscalDocumentService.createNfeForSale passa a cidade do destinatário. Tela: a ficha do pedido, com doCodigo de outra UF, oferece "Manter o código e corrigir a UF para <UF>". Nenhuma rota, coluna, tabela ou passo novo (526 rotas; CORE_TARGET_VERSION 85 intocado). \|\| Antes: R3-IBGE (81134b3, ebf4940): MunicipiosIbge ganha a régua única — municipioDaNotaQueNaoConfere (destinatário: código × UF), municipioDoEmitenteQueNaoConfere/problemaDoMunicipioDoCadastro (emitente: código × UF × nome da cidade, sem acento/caixa/espaço), municipioPeloNome (sugestão quando há uma só cidade com o nome na UF) e emitentesForaDaTabela(db) (para a conferência, com a conexão só-leitura); todas mudas com a tabela vazia (a regra de antes). OrderInvoiceService: destinatarioDoPedido diz de onde o destinatário sai (retrato de faturamento, de entrega, ou endereço da conta); a prontidão traz municipio {lado, uf, cidade, codigo, motivo, sugestao} e o motivo diz o que corrigir e onde (Pedidos › este pedido › Nota fiscal do pedido); createNfeForOrder recusa com dest.cMun (409 CORE_FISCAL_DOCUMENT_INVALID) ANTES do leiaute e da reserva do número; corrigirMunicipioDaNotaDoPedido + POST /core/orders/:id/nfe/municipio (gerente_loja): só o município muda (nome e código; rua, número, bairro, CEP e UF ficam), só com a tabela (409), só quando o código de hoje não confere (409), só antes da nota (409), só município da UF do endereço (422), formato (400); pedido de antes do retrato ganha o retrato do faturamento a partir do endereço da conta; evento no histórico do pedido (addOrderEvent, de → para) e auditoria; devolve a prontidão recalculada. FiscalDocumentService.createNfeForSale: a mesma recusa do destinatário antes de numerar. FiscalConfigService: updateFiscalConfig confere o cadastro COMO FICARÁ quando cityIbge, uf ou cityName vêm (422 CORE_FISCAL_IBGE_NAO_CONFERE, com o motivo e Fiscal › Emitente); o item ibge do checklist fica FAIL/DIVERGENTE com o motivo — está no portão de montagem, então NF-e e NFC-e recusam antes de numerar. NfseService: nfse_emitente FAIL com o motivo (a emissão da DPS já barra na prontidão, antes de reservar o número). Conferência da implantação: item "Município do emitente na tabela do IBGE" (OK / ATENÇÃO com cada operação e o motivo; não aparece sem a tabela ou sem emitente com código) — ATENÇÃO e não BLOQUEIA porque o conserto é pela tela, com a API no ar; na rota pela conexão da API, no comando pelo arquivo aberto só para leitura. Tela: FaturamentoPedido (GestaoPages) mostra, com municipio na prontidão, o grupo "Corrigir o município do endereço da nota" — a sugestão pelo nome já escolhida, ou a cidade escolhida na lista (CidadeComSugestoes, na UF do endereço); a resposta troca o aviso pelo botão Emitir NF-e; a recusa aparece com a frase do servidor. Nenhuma coluna, tabela ou passo novo (CORE_TARGET_VERSION 85 intocado). \|\| Antes: Verificação adversarial: CheckoutIdentityService ganha codigoQueNaoConfere(retrato) (sem código ou tabela vazia = nada a recusar; com a tabela e código que não é município da UF = o porquê); enderecoDoCheckout(…, "faturamento") recusa com 422 CHECKOUT_ENDERECO_INCOMPLETO (details addressId, uso, faltando [ibge], municipio; a frase diz o código e manda escolher a cidade de novo em Minha conta), antes de cotar, reservar ou cobrar — a tela mostra a frase do servidor; faturamentoPadraoDaConta não usa endereço cujo código não confere (pula para o próximo de faturamento que confere, ou fica sem e a nota do pedido diz que falta, em vez de inventar município). A entrega segue em conferirEntregaDaConta, sem mudança de ordem nem de frase. Sem a tabela, nada muda. Tabela core_ibge_municipios na DDL canônica (código de 7 dígitos como chave, nome, UF, nome_busca sem acento), nascendo VAZIA; tabela nova sem dado a corrigir, o boot a cria no banco da 84 (sem passo numerado; passo 85 intocado); na ordem de exclusão. Serviço MunicipiosIbge (lê o JSON da API de localidades do IBGE — UF pela microrregião ou, quando ela é nula, pela região imediata — ou CSV codigo;nome;uf; confere 7 dígitos, prefixo da UF, nome, duplicata e total plausível 5.500–5.700; grava numa transação, idempotente; busca; confere código x UF). Comando do dono scripts/carregar-municipios-ibge (npm run ibge:municipios; node server/dist/scripts/carregar-municipios-ibge.js --baixar \| --arquivo): --baixar busca a URL oficial só quando o dono roda (fetch injetável nos testes); lista inválida não grava nada; diz novos/alterados/removidos/iguais. Rota pública GET /api/v1/loja/municipios?uf=&q= (rotaPublica, sem acento e sem caixa, por UF, começo do nome primeiro, até 20, sob o limite de taxa global, com carregada/total). Com a tabela: salvar endereço exige código que existe e é da UF (422 PORTAL_IBGE_NAO_CONFERE com o nome da cidade do código) e o fechamento com entrega reconfere o endereço salvo antes da tabela (422 CHECKOUT_ENDERECO_INCOMPLETO, faltando [ibge], com o motivo); sem a tabela, a regra de antes (formato e prefixo). Tela: CidadeComSugestoes (combobox com lista; setas, Enter escolhe sem salvar o formulário, Esc, nome exato ao sair) + useTabelaDeMunicipios; FormularioDeEndereco com a tabela vira UF + Cidade com sugestões e o código vem junto (o cliente nunca digita), mexer no nome ou trocar a UF tira o código; sem a tabela (ou servidor fora) os três campos e o texto de ajuda de antes; FiscalPage (emitente) usa o mesmo seletor sem reescrever a tela. Conferência da implantação: item "Tabela de municípios do IBGE" OK com a contagem / ATENÇÃO (pendente) com o comando / INFO sem banco — na rota pela conexão da API, no comando pelo arquivo aberto só para leitura. DEPLOY.md e GO_LIVE_CHECKLIST.md com o comando. |
| DEPOIS | Já se sustenta: a loja exige conta por padrão, com política por loja, tela e trilha. O servidor bloqueia cadastro incompleto (e-mail provado 403, nome/CPF/telefone 422, documento divergente 409). O checkout pré-preenche, o endereço salvo por shippingAddressId vira retrato no pedido, e há o botão 'Trazer minhas compras pelo CPF'. Falha: com sessão, o servidor ainda aceita endereço de entrega em texto solto sem shippingAddressId. Só a tela obriga o endereço salvo, e o comentário da tela diz, sem ser verdade, que o servidor recusaria. |
| Arquivos | server/src/services/core/CheckoutIdentityService.ts, server/src/services/core/CustomerAccountService.ts, server/src/routes/v1/storefront.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, src/lib/api/checkoutPolicy.ts, src/components/gs/PoliticaDoCheckout.tsx, src/components/gs/CheckoutDaConta.tsx, src/components/gs/TrazerMinhasCompras.tsx, src/pages/gs/LojaPage.tsx, src/pages/gs/LojaAdminPage.tsx, src/pages/gs/MinhaContaPage.tsx, server/tests/checkout-exige-conta.test.ts, server/tests/helpers/lojaAberta.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/checkoutComConta.test.tsx, src/components/gs/__tests__/politicaDoCheckout.test.tsx, src/components/gs/__tests__/trazerMinhasCompras.test.tsx, server/tests/checkout-conta-entrega-no-endereco-salvo.test.ts, src/lib/api/enderecos.ts, src/components/gs/ContaDoCliente.tsx, src/components/gs/FormularioDeEndereco.tsx, src/pages/gs/__tests__/entregaNoEnderecoCompleto.test.tsx, src/components/gs/__tests__/enderecosComRetrato.test.tsx, server/tests/checkout-conta-entrega-recusa-antes-da-cotacao.test.ts, server/src/services/core/MunicipiosIbge.ts, server/src/scripts/carregar-municipios-ibge.ts, server/src/services/implantacao/conferenciaDaImplantacao.ts, server/tests/municipios-do-ibge.test.ts, package.json, docs/DEPLOY.md, docs/GO_LIVE_CHECKLIST.md, src/lib/api/municipios.ts, src/hooks/useTabelaDeMunicipios.ts, src/components/gs/CidadeComSugestoes.tsx, src/pages/gs/FiscalPage.tsx, src/components/gs/__tests__/cidadePeloNomeDoIbge.test.tsx, server/tests/municipios-do-ibge-no-faturamento.test.ts, server/src/services/core/OrderInvoiceService.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/core/FiscalDocumentService.ts, server/src/services/core/NfseService.ts, server/tests/municipios-do-ibge-na-emissao.test.ts, src/lib/api/core.ts, src/pages/gs/GestaoPages.tsx, src/pages/gs/__tests__/municipioDaNotaDoPedido.test.tsx |
| COMMIT | 9d3c286, 4313dbe, 0ce1496, d8cef87, 087128e, a17826e, fb00c67, 7b8e41d, b323e25, 9a55798, 2380234, 847e4f6, b2a2162, d2aaf09, 07dda2f, 81134b3, ebf4940, acd5dc9, a0b0be7, 2c1e3af |
| TESTES | server/tests/checkout-exige-conta.test.ts: conta obrigatória por padrão, visitante só se o dono abrir, token vencido 401, cadastro incompleto 403/422/409, shippingAddressId copiado e de outra conta 404, política com permissão e trilha. O teste :364-392 manda shippingAddressId junto com texto; nenhum teste afirma recusa de conta+entrega sem endereço salvo. Tela: checkoutComConta, politicaDoCheckout, trazerMinhasCompras. Rodado: verde. |
| EVIDÊNCIA | Correto: storefront.ts:649-675 (401 CHECKOUT_CONTA_OBRIGATORIA, prepararComprador); CheckoutIdentityService.ts:68-111 (padrão 'conta'), 143-227 (cadastro completo); core.ts:15988-16016 (checkout-policy, gerente, auditoria); LojaAdminPage.tsx:308; MinhaContaPage.tsx:631 (TrazerMinhasCompras). Falha: storefront.ts:696-706 (shippingAddress = req.body.shippingAddress; só é trocado se vier shippingAddressId; nenhuma recusa para conta + entrega sem endereço salvo) e StorefrontService.ts:1480 (grava input.shippingAddress). O grep por CHECKOUT_ENDERECO só acha o CHECKOUT_ENDERECO_TIPO (CheckoutIdentityService.ts:306). A tela bloqueia em LojaPage.tsx:553-559, cujo comentário diz 'o servidor recusaria depois'. |
| Veredito independente | PARCIAL (contraprova concorda) — contraprova: concorda (OPEN) |
| O que a reauditoria apontou | 1) In server/src/routes/v1/storefront.ts, POST /loja/checkout, after resolverFretesDoCarrinho (lines 738-744) and before calling checkout() (line 776, where stock gets reserved): if there is a session (sessao) and some shop in shippingPorEmpresa has method !== METODO_RETIRADA and enderecoDeEntrega is null, refuse with an ApiError 422 (for example CHECKOUT_ENDERECO_SALVO_OBRIGATORIO). Nothing may be reserved or numbered. Also stop reading req.body.shippingAddress/shippingZip from logged-in customers (lines 696-697), so typed text never becomes a logged-in customer's delivery address. 2) Add a server test to server/tests/checkout-exige-conta.test.ts. Setup: a shop that delivers (core_shipping_settings delivery_enabled=1, flat_rate_cents), a complete verified account, shippingMethod 'tabela_da_loja' with only shippingAddress. Expect 422, reserved = 0, zero rows in core_orders. Add a second case: the account has a saved address with IBGE but sends typed text; also 422. 3) The ficha also requires IBGE and a recipient (destinatário) when closing. Today, when the account picks a saved address, the order stores that address as a column snapshot. But an address saved for delivery only, with no IBGE and no recipient, passes, and the recipient becomes the buyer's name. Either the server rejects this for accounts, or an owner decision is written into gaps.json. Today the only record is the remediator's own note in GAP-PRD-115 ("Endereço sem IBGE serve para entregar"), not the owner's. |
| Correção depois da reauditoria | RESOLVED_PROVEN — A reauditoria (auditor ECO1 + contraprova) achou que, com conta e entrega, o servidor ainda aceitava endereço em texto solto (só a tela obrigava o salvo) e que o fechamento não exigia IBGE nem destinatário. 0ce1496: com sessão do portal e alguma loja entregando, POST /loja/checkout recusa sem endereço salvo da conta (422 CHECKOUT_ENDERECO_SALVO_OBRIGATORIO) e recusa endereço incompleto nomeando tudo o que falta (422 CHECKOUT_ENDERECO_INCOMPLETO: rua, número ou S/N, bairro, cidade, UF, CEP, IBGE); o retrato do pedido grava IBGE e destinatário (o do endereço ou o nome do comprador). d8cef87: a tela diz o que falta e deixa completar ali. O verificador adversarial achou a recusa saindo depois da cotação do frete (e com 400 SHIPPING_OPTION_UNAVAILABLE quando faltava CEP) e corrigiu em a17826e: a conferência vem antes de cotar qualquer loja. Retirada e visitante seguem como antes. Verificação final: o verificador achou que o cliente teria de digitar o código IBGE do município, que não sabe, para fechar a compra com entrega. b323e25: tabela core_ibge_municipios (DDL canônica, vazia — nada inventado), comando do dono que carrega a lista OFICIAL do IBGE (--baixar ou --arquivo; valida 7 dígitos, prefixo da UF, faixa plausível, duplicatas; idempotente), busca pública GET /loja/municipios e item novo na conferência da implantação. 9a55798: com a tabela, o cliente escolhe UF e cidade e o código vem junto (também no emitente); sem ela, o campo digitado de hoje. O verificador achou o endereço da NOTA sem a conferência na tabela e corrigiu em b2a2162. Rodada 3: com a tabela carregada, a prontidão e a emissão da nota do pedido (e a NF-e de venda) conferem o município do destinatário e o do emitente antes de numerar — divergente recusa sem queimar número; o cadastro do emitente confere código × UF × nome (422) e o checklist e a conferência da implantação apontam (81134b3); a ficha do pedido corrige o município ali mesmo, só gerente_loja, com evento e auditoria (ebf4940). O verificador achou a cidade escrita que desmente o código, o emitente com a UF no fim e a UF errada vinda da 84, e corrigiu em a0b0be7. Prova: Verificador em int/hard-028: arquivo novo 5/5; domínio do checkout 11 arquivos 144/144; suíte do servidor 505/505 arquivos (6880 casos, 18 skip); telas do domínio 11 arquivos 106/106; suíte de tela 255/255 (2446); tsc (3) e eslint (raiz e servidor) 0. Verificador: municipios-do-ibge-no-faturamento 6/6; domínio 5 arquivos 68/68; suíte do servidor 510/511 (zip-writer: o Expand-Archive desta máquina, conhecido); tela 257/257 (toda-tela-monta isolado 207/207). Rodada 3: verificador: municipios-do-ibge-na-emissao 41/41; domínio 22 arquivos 336/336; suíte do servidor 520/520 (7091); tela 264/264 (2489). |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Rodar uma vez, no servidor, depois que o banco existir: node server/dist/scripts/carregar-municipios-ibge.js --baixar (ou --arquivo municipios.json, com a lista oficial baixada em outra máquina). Enquanto não roda, o cliente digita o código IBGE e a conferência da implantação mostra o item PENDENTE com esse comando. |

### GAP-PRD-029 — Boleto vence em D+1 mas a reserva expira em 25h: pedido de boleto é cancelado antes de vencer e o pagamento compensado vira 'paid_after_cancel'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / INCONSISTENT_CONTRACT |
| Empresa / frente | todas as lojas com boleto habilitado / ECO |
| ANTES | O boleto vencia em D+1, mas a reserva expirava em 25h fixas. O pedido era cancelado antes do vencimento, e o pagamento compensado virava paid_after_cancel. |
| Causa | Um relógio único de 25h, calibrado para o PIX (cuja cobrança morre junto no provedor), aplicado ao boleto, que pago no vencimento é compensado em D+1 útil; o vencimento enviado não era guardado, então a rotina não tinha como saber até quando o boleto podia ser pago. |
| Correção | PrazoDaReserva (definição única): PIX e cartão 25h (piso de qualquer reserva); boleto emitido no provedor e pendente (pending/overdue) vale até o fim do dia da loja do 2º dia útil depois do último dia de pagamento (vencimento, ou o próximo dia útil quando cai em fim de semana ou feriado); linha antiga sem vencimento usa o D+1 da criação. DiasUteis: dia da semana pela data de calendário (independe do fuso do processo), feriados bancários nacionais (fixos, Consciência Negra desde 2024, carnaval seg/ter, Paixão, Corpus Christi pela Páscoa de Meeus). core_payment_intents.due_date gravado na criação da cobrança. expirarPedidosNaoPagos filtra pelo piso e pergunta o prazo de cada pedido antes de cancelar (conta emCompensacao). createOrderCharge devolve reservedUntil (e o dueDate guardado na releitura); o checkout o repassa. LojaPage: no boleto, 'Pague até dd/mm/aaaa' e 'Seus itens ficam reservados até dd/mm/aaaa — o tempo de o banco confirmar', no dia da loja via dataBR, com a linha digitável; PIX e cartão inalterados. |
| DEPOIS | O prazo da reserva é por método. Boleto emitido e pendente vale até o fim do 2º dia útil depois do último dia pagável, com fim de semana e feriados nacionais. PIX e cartão ficam em 25h. O vencimento é gravado na intenção, a expiração consulta o prazo de cada pedido antes de cancelar, e a tela diz até quando pagar e até quando reserva. |
| Arquivos | server/src/services/core/PrazoDaReserva.ts, server/src/services/core/DiasUteis.ts, server/src/services/core/OrderReservationExpiry.ts, server/src/services/core/OrderChargeService.ts, server/src/services/core/PaymentService.ts, server/src/db/schema.ts, server/src/routes/v1/storefront.ts, src/pages/gs/LojaPage.tsx, src/pages/gs/__tests__/LojaPage.test.tsx, server/tests/boleto-reserva-ate-compensar.test.ts, server/tests/dias-uteis-da-loja.test.ts, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 56ee82f |
| TESTES | server/tests/boleto-reserva-ate-compensar.test.ts: reprodução da auditoria (25h depois segue reservado), vencimento no sábado, feriado, linha antiga sem vencimento, due_date guardado, reservedUntil, PIX ainda cancela em 25h, boleto não emitido segue 25h. dias-uteis-da-loja.test.ts. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/PrazoDaReserva.ts (prazoDaReserva: boleto = fimDoDia(somarDiasUteis(proximoDiaUtil(vencimento), 2)); cobrancasVivasDoPedido só pending/overdue com provider_ref); OrderReservationExpiry.ts (expirarPedidosNaoPagos: se agora <= prazo.ate, conta emCompensacao e não cancela); OrderChargeService.ts:303-319 (grava due_date), :157 e :400 (reservedUntil); src/pages/gs/LojaPage.tsx:2160-2166. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-030 — Melhor Envio: cotação real só em sandbox e só com LOGISTICS_HOMOLOGATION_TESTS=true — em produção o checkout não chama a transportadora

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas as cinco lojas de varejo / LOG |
| ANTES | Não havia URL de produção do Melhor Envio. LOGISTICS_PRODUCTION_ENABLED=true desligava as chamadas reais, e o checkout só cotava com LOGISTICS_HOMOLOGATION_TESTS=true. Com token gravado, o cliente via só retirada ou a tabela da loja. |
| Causa | Nao havia endereco de producao no adapter; a flag de producao desligava as chamadas reais em vez de liga-las; a cotacao sem transportadora escolhida (checkout e pagina do produto) dependia de uma variavel de teste. Achados no caminho: servico devolvido pelo Melhor Envio com error virava preco 0 (frete gratis no checkout); upsert sem storeId duplicava a linha (undefined x null) e a leitura devolvia o token antigo; gravar credencial de producao era 403 com a trava desligada. |
| Correção | MelhorEnvioClient novo (URL pelo ambiente da credencial, LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL, variavel vazia cai no endereco publico, User-Agent com contato tecnico, erros com codigo, descarte de servico com error/sem preco, custom_price). resolveCarrierAccess: credencial + trava de processo LOGISTICS_PRODUCTION_ENABLED (regua do Asaas) decidem; so producao e cobravel (sandbox sai simulated:true/real:true/environment:sandbox e o checkout ja descarta simulated). Guarda de processo: DEVORA_API_ENV/NODE_ENV=production recusa simulacao e sandbox. backendLogisticsQuote cota toda transportadora com credencial pelo proprio adapter. Credencial: escopo corrigido, duplicatas limpas na gravacao, sem copia apiKeyEncrypted, dica mascarada, contato tecnico, resultado de conexao e de cotacao em campos proprios. |
| DEPOIS | O endereço sai do ambiente da credencial: produção vai para melhorenvio.com.br e sandbox para sandbox.melhorenvio.com.br. Token de produção + LOGISTICS_PRODUCTION_ENABLED=true dá chamada real cobrável. O checkout cota toda transportadora com credencial, descarta sandbox/simulado e recota no servidor ao fechar o pedido. A variável de teste não existe mais no caminho. |
| Arquivos | server/src/services/logistics/MelhorEnvioClient.ts, server/src/services/logistics/LogisticsCarrierAdapter.ts, server/src/services/logistics/LogisticsCredentialService.ts, server/src/services/logistics/LogisticsReadinessService.ts, server/src/services/logistics/LogisticsService.ts, server/src/routes/v1/logistics.ts, server/src/config/env.ts, .env.example, .env.production.example, .env.staging.example, server/tests/melhor-envio-producao.test.ts |
| COMMIT | b6ce6bd |
| TESTES | server/tests/melhor-envio-producao.test.ts, describe GAP-PRD-030 (:207-338): token de produção chama https://melhorenvio.com.br/api/v2/me/shipment/calculate com Bearer e User-Agent e oferece transportadora:melhor_envio:1/2 com custom_price; serviço com error não vira R$ 0; sandbox cota o sandbox mas o checkout não cobra; trava desligada = 0 chamadas e o nome da trava na prontidão; 401 cai na tabela. Rodado: 7 arquivos do lote, 82 verdes e 1 pulado (o sandbox REAL do prompt17, que exige token). |
| EVIDÊNCIA | server/src/services/logistics/MelhorEnvioClient.ts:68-88 (URL por ambiente, variável vazia cai no padrão) e :203-238 (cotação, serviço com error ou sem preço descartado). LogisticsCarrierAdapter.ts:142-193 (resolveCarrierAccess; a trava de produção em :182). LogisticsService.ts:251-273 (cota as configuradas, sem flag de teste). CheckoutShippingService.ts:225-247 (descarta simulated) e :335-354 (resolveCheckoutShipping recota ao fechar; chamado em routes/v1/storefront.ts:579). config/env.ts:303 e :312. .env.production.example:139-141. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Token de PRODUÇÃO do Melhor Envio de cada operação, colado em Loja → Logística (ambiente Produção), com Testar conexão OK. LOGISTICS_PRODUCTION_ENABLED=true no .env da API. E-mail de contato técnico (opcional). A primeira chamada real à produção não foi medida: o contrato da API só foi provado contra fetch dublado. |

### GAP-PRD-031 — Devolução de pedido pago não deixa contrapartida financeira: a receita 'settled' permanece e não há baixa para estornar

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas / ECO |
| ANTES | A devolução de pedido pago só mexia em status, estoque e provedor. A receita seguia liquidada, sem saída nem baixa a estornar. |
| Causa | A entrada do pedido nasce quitada e sem baixa; nenhum escritor lançava a volta do dinheiro, e não havia baixa a desfazer pela tela. |
| Correção | OrderRefundLedger.lancarContrapartidaDoReembolso na mesma transação do reembolso: saída origin_type ecommerce_order_refund, categoria devolucao, competência e vencimento no dia da loja, valor da receita do pedido. Quitada com baixa espelho quando o provedor devolveu (estorno ok, ou aviso PAYMENT_REFUNDED/CHARGEBACK); em aberto (conta a pagar ao cliente) quando não; o aviso posterior do provedor quita a aberta, uma vez; a UNIQUE de core_finance_entries segura repetição. Rótulo "Reembolso do pedido online #N" e JOIN em FinanceService, link em rotasDeOrigem, a ficha do pedido lista receita e reembolso. O resultado da devolução diz dinheiro, mercadoria e pendência fiscal (NF-e autorizada vira evento e aviso). O BI passou a contar os reembolsos como devolução (e3140f7). |
| DEPOIS | markOrderRefunded lança, na mesma transação, a saída ecommerce_order_refund (categoria devolução, competência e vencimento no dia da loja). Ela nasce quitada com baixa espelho quando o provedor devolveu, ou em aberto quando não. O aviso posterior do provedor quita uma vez só, a UNIQUE impede duplicata, e o webhook de estorno/contestação usa o mesmo caminho. |
| Arquivos | server/src/services/core/OrderRefundLedger.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/OrderChargeService.ts, server/src/services/core/PaymentService.ts, server/src/services/core/FinanceService.ts, src/lib/rotasDeOrigem.ts, src/lib/api/pedidos.ts, server/tests/pedido-devolucao-dinheiro-e-mercadoria.test.ts, server/tests/titulo-e-origem-sao-navegaveis.test.ts, server/tests/ecommerce-jornada.test.ts |
| COMMIT | 4163e64, e3140f7 |
| TESTES | server/tests/pedido-devolucao-dinheiro-e-mercadoria.test.ts, bloco GAP-PRD-031 (:339+): saída em aberto no dia da loja, DRE do dia cai, estorno pelo provedor nasce quitado com baixa, falha no provedor seguida de aviso quita uma vez, webhook repetido não duplica, devolver duas vezes não duplica, NF-e autorizada vira pendência. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/OrderRefundLedger.ts:92+ (lancarContrapartidaDoReembolso; INSERT out com ON CONFLICT; inserirBaixaEspelho; settleEntry na quitação posterior); StorefrontService.ts:1892-1962 (markOrderRefunded em withTransaction chama a contrapartida; repetição só quita); PaymentService.ts:1287-1294 (webhook com dinheiro devolvido_pelo_provedor); OrderChargeService.ts:683-697. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-032 — Promoções sem validação: preço negativo e >100 % gravados e ignorados em silêncio; 100 % deixa o produto GRÁTIS em loja e PDV; fim antes do início aceito

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas (promoção vale nos dois canais) / ECO |
| ANTES | A API gravava preço negativo, percentual >100 e fim antes do início, e 100% deixava o produto grátis na loja e no PDV. |
| Causa | A rota era o único escritor e não conferia nada além da presença de um desconto; o cálculo do preço aceitava zero como candidato válido. |
| Correção | PromotionService.conferir (escritor único): alvo = UM produto ou UMA categoria; desconto = UM preço fixo em centavos inteiros (>= 0, menor que o de cadastro do produto, senão 400 CORE_PROMOTION_NOT_A_DISCOUNT) OU percentual 0 < p <= 100; 100 % ou preço zero só com confirmarGratis:true (400 CORE_PROMOTION_FREE_UNCONFIRMED), gravado em core_promotions.free_confirmed; datas inválidas e fim < início → 400 CORE_PROMOTION_PERIOD; categoria que não existe (produtos nem Categorias e marcas) → 400 CORE_PROMOTION_CATEGORY_EMPTY, grafia normalizada para a do cadastro. PricingService: candidato zero só entra com free_confirmed = 1 (legado de 100 % deixa de dar o produto de graça). GET /core/promotions devolve `problemas` por linha (legado que a regra de hoje recusaria). Tela: a recusa do servidor aparece com as palavras dele, a confirmação do grátis é perguntada antes de chamar a API, linha legada aparece como "Inválida" com o motivo. |
| DEPOIS | PromotionService.conferir é o escritor único e recusa: preço não inteiro, negativo ou não menor que o de cadastro; percentual fora de 0<p<=100; os dois juntos; fim < início; grátis sem confirmarGratis. O cálculo só aceita candidato zero com free_confirmed=1. A tela pede a confirmação do grátis antes de chamar. |
| Arquivos | server/src/services/core/PromotionService.ts, server/src/services/core/PricingService.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, server/tests/promocao-validada.test.ts, src/pages/gs/PromocoesPage.tsx, src/pages/gs/GestaoPages.tsx, src/lib/api/promocoes.ts, src/pages/gs/__tests__/promocoesValidadas.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 5d910f9, 9d51033 |
| TESTES | server/tests/promocao-validada.test.ts, bloco GAP-PRD-032: negativo 400 sem gravar, >100 400, zero/negativo 400, NaN 400, 100% sem confirmação 400 e produto não fica grátis, com confirmação 201, preço não-desconto 400, fim antes do início 400, legado inválido não vale no preço. Tela: promocoesValidadas.test.tsx. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/PromotionService.ts:335-362 (preço/percentual/grátis) e 374-379 (período); PricingService.ts:432-434 (aceitavel = candidate > 0 \|\| zero confirmado); core.ts:13389-13401 (POST usa criarPromocao) e 13428-13438 (PATCH usa editarPromocao); src/pages/gs/PromocoesPage.tsx:255-270 e 452-456. Único outro escritor: DELETE (core.ts:13461) só desativa. A CHECK na tabela não foi feita (declarado em migracoes/ECO.md). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-033 — Promoção por produto: tela pede 'Código do produto' mas a API exige o UUID — código interno vira FK violada e 500 'Erro interno'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas / ECO |
| ANTES | A tela pedia 'Código do produto', mas a API exigia o UUID. O código interno virava FK violada e 500 'Erro interno'. |
| Causa | O corpo ia cru para a FK; não havia resolução do código nem seletor. |
| Correção | PromotionService.resolverProduto acha o produto DA EMPRESA pelo id, código interno, código de barras principal ou adicional (core_product_barcodes); não achado → 404 CORE_PROMOTION_PRODUCT_NOT_FOUND nomeando o código; produto inativo → 400; modelo com grade → 400 CORE_PRODUCT_HAS_VARIANTS (a loja e o balcão precificam a variante pelo id dela, e a promoção no modelo não valeria). A lista traz product_name/product_code. Tela: SeletorDeProduto (busca em /core/products?search=, escolha na lista manda o id; o código digitado sem escolher também vale — o servidor resolve). |
| DEPOIS | O servidor resolve o produto da empresa por id, código interno, código de barras ou barras adicional. Não achado dá 404 nomeando o código; inativo ou com grade dá 400. A tela tem seletor de produto com busca, e a lista traz nome e código. |
| Arquivos | server/src/services/core/PromotionService.ts, server/src/routes/v1/core.ts, server/tests/promocao-validada.test.ts, src/components/gs/SeletorDeProduto.tsx, src/pages/gs/PromocoesPage.tsx, src/lib/api/promocoes.ts, src/pages/gs/__tests__/promocoesValidadas.test.tsx, src/pages/gs/__tests__/PromocoesPage.test.tsx |
| COMMIT | 5d910f9, 9d51033 |
| TESTES | server/tests/promocao-validada.test.ts, blocos GAP-PRD-033 (:260-297: código interno 201, barras 201, inexistente 404 nomeando o código, grade 400, lista com nome e código) e GAP-PRD-197 (outra empresa 404). Tela: promocoesValidadas.test.tsx. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/PromotionService.ts:158-209 (resolverProduto com company_id em todas as buscas; 404 CORE_PROMOTION_PRODUCT_NOT_FOUND; 400 inativo e grade); src/components/gs/SeletorDeProduto.tsx usado em src/pages/gs/PromocoesPage.tsx. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-034 — Configuração operacional do dia 1 ainda não feita: entrega, medidas dos produtos, CEP de origem, Asaas, SMTP

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Todas (detalhe por empresa abaixo) / LOG |
| ANTES | Nada da configuração do dia 1 estava feito: nenhuma entrega configurada, produtos publicados sem medidas, CEP de origem só em uma operação, sem Asaas, sem SMTP e sem credencial logística. Cada item tinha tela, mas nenhum lugar reunia o que faltava. |
| Causa | Configuracao do dia 1 espalhada em seis telas, sem lista por operacao dizendo o que falta, quem resolve e onde. |
| Correção | ProntidaoDoDiaUm (servico) + GET /core/loja/prontidao-do-dia-1 (requireProfile gerente_loja/gerente_oficina; quem responde pelo grupo ve todas as operacoes): entrega (escolha/ok), produtos publicados, medidas (com nomes), CEP de origem, remetente da etiqueta, transportadora (escolha/ok/pendente pela trava do servidor), Asaas (sandbox/ausente + pedidos que nasceram sem cobranca), SMTP (quem resolve: servidor, com as variaveis faltantes). Tela /sistema/loja/prontidao no menu E-commerce (QUEM_RESPONDE_PELA_LOJA). GO_LIVE_CHECKLIST secao 7 com os passos novos. |
| DEPOIS | Existe a prontidão do dia 1 por operação: entrega, produtos, medidas pelo nome, CEP, remetente, transportadora, Asaas e SMTP. Cada item diz o estado, quem resolve (loja ou servidor) e em que tela. Toda tela citada existe no roteador. Resta só configurar. |
| Arquivos | server/src/services/logistics/ProntidaoDoDiaUm.ts, server/src/routes/v1/core.ts, src/pages/gs/ProntidaoDoDiaUmPage.tsx, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, server/tests/prontidao-do-dia-1.test.ts, src/pages/gs/__tests__/ProntidaoDoDiaUm.test.tsx, server/tests/o-menu-nao-promete-o-que-o-servidor-nega.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/router/__tests__/environments.test.tsx |
| COMMIT | 2cfc103, 47d82c8 |
| TESTES | server/tests/prontidao-do-dia-1.test.ts: retrato de operação nova; produto sem medida aparece pelo nome; unconfigured contado no item Asaas; tudo vira ok ao configurar pelas funções das telas; Asaas sandbox e trava do servidor; gerente vê só a dele e o gestor do grupo vê todas; estoquista/atendente 403. src/pages/gs/__tests__/ProntidaoDoDiaUm.test.tsx. Rodados, verdes. |
| EVIDÊNCIA | server/src/services/logistics/ProntidaoDoDiaUm.ts:64-232 (os itens e quem/onde). routes/v1/core.ts:16421-16432 (GET /core/loja/prontidao-do-dia-1: requireProfile gerente_loja/gerente_oficina; companyId da sessão; o grupo só para quem responde por ele). src/router/gsRoutes.tsx:633 (/sistema/loja/prontidao). navItems.ts:670. As rotas /sistema/loja/entrega, /sistema/fiscal/configuracao, /sistema/integracoes/asaas, /sistema/loja/emails, /sistema/loja/logistica e /sistema/produtos/prontidao-online estão todas em gsRoutes.tsx. src/lib/api/envios.ts:187. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Por operação, pelas telas: ligar a entrega e informar a tabela (Loja → Entrega); peso e medidas dos produtos publicados; CEP e endereço completos em Fiscal → Configuração; chave Asaas de produção; token Melhor Envio (opcional se a tabela bastar). No servidor: EMAIL_ENABLED, EMAIL_FROM e EMAIL_SMTP_*, e LOGISTICS_PRODUCTION_ENABLED=true se usar o token de produção. |

### GAP-PRD-035 — Leitura IMAP satura em 25 mensagens não lidas: nunca marca \Seen e a 26ª NF-e nunca entra

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | Todas que usarem NF-e por e-mail (hoje só Preço Justo tem caixa cadastrada) / EML |
| ANTES | Cada leitura buscava {seen:false} com teto de 25 e nunca marcava nada como lido. As mesmas 25 voltavam sempre, e a 26ª NF-e nunca entrava. |
| Causa | O "novo" era definido por "não lida", mas o sistema nunca marcava nada como lida (o imapflow baixa com BODY.PEEK) e o teto de 25 pegava sempre as mesmas mais antigas; o dedupe por provider_uid mascarava o reprocessamento. |
| Correção | Cursor por caixa: core_mail_inboxes.imap_uid_validity + imap_last_uid (DDL canônica, anuláveis). Primeira leitura (ou UIDVALIDITY novo) busca {seen:false}; as seguintes SEARCH uid "<último+1>:*" com filtro uid > último (a regra do N:* do RFC 3501). Lote de 25 do mais antigo ao mais novo, cursor andando a cada mensagem; restantes na resposta e em imap_pending; o agendador reagenda em 1 min enquanto sobrar, e o resumo diz quantas ficaram. Depois de processada: marcar como lida (after_read=lida, padrão — DEFAULT da coluna), mover para processed_folder (mailboxCreate se não existir; falha vira "lida" + aviso) ou manter; validação de after_read/pasta no upsert (400). Nenhum comando dentro de laço de fetch: SEARCH, fetchAll de tamanhos e fetchOne um a um. Mensagem > 25 MB não é baixada (outcome novo "ilegivel" com o motivo); mensagem apagada entre busca e download é pulada; mailparser que falha vira "ilegivel"; STORE recusado vira aviso e não reprocessa; erro de banco no processamento derruba a leitura sem andar o cursor. provider_uid passa a "<UIDVALIDITY>:<UID>@<pasta>", com as linhas do formato antigo convertidas na primeira leitura da caixa (migracoes/EML.md M3-1). Trocar endereço/servidor/usuário/pasta zera o cursor. Tela: "Ler agora" diz quantas leu e quantas restam, a caixa mostra "Aguardando leitura" e "Depois de ler", o formulário escolhe o que fazer com a lida. |
| DEPOIS | Cada caixa tem um cursor por UIDVALIDITY e último UID. A partir da segunda leitura, busca UID > último, com filtro contra a regra N:*. A mensagem processada é marcada \Seen (padrão), movida ou mantida, e o cursor anda a cada mensagem. A resposta diz quantas restam, e o agendador volta em 1 min. |
| Arquivos | server/src/services/core/MailInboxService.ts, server/src/services/core/MailInboxScheduler.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/helpers/imapFalso.ts, server/tests/imap-leitura-que-nao-satura.test.ts, src/lib/api/core.ts, src/pages/gs/EntradaEmailPage.tsx, src/pages/gs/__tests__/EntradaEmailPage.test.tsx, docs/audits/remediacao/migracoes/EML.md |
| COMMIT | 9738104, b6dcfba |
| TESTES | server/tests/imap-leitura-que-nao-satura.test.ts:103-115: 25 propagandas + 5 NF-e dão checked 25 e depois 5, 30 mensagens gravadas e a chave 26 presente. Outros casos cobrem as marcas \Seen só nas processadas, N:*, UIDVALIDITY e nenhum comando dentro de fetch. EntradaEmailPage.test.tsx: 'Ler agora diz quantas restam'. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/MailInboxService.ts:684-721 (cursorDaCaixa/avancarCursor), :898-918 (busca por cursor, filtro uid>cursor, lote e restantes), :1001-1012 (messageFlagsAdd \Seen ou messageMove, depois avança o cursor), :1019-1026 (imap_pending); server/src/routes/v1/core.ts:1410-1428; src/pages/gs/EntradaEmailPage.tsx:76-85 e :214-222. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-036 — "Enviar orçamento ao cliente" na OS não envia nada — a oficina não tem nenhuma comunicação

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | Oficina, PJ Motors (workshop) / EML |
| ANTES | 'Enviar orçamento ao cliente' só gravava approval_requested_at e rotulava como 'enviado'. Não existia nenhum modelo de e-mail de OS. |
| Causa | A oficina não tinha nenhum canal com o cliente: o pedido de aprovação, a conclusão e o pagamento mudavam só estado interno, e a tela afirmava um envio que não existia. |
| Correção | Módulo novo server/src/services/notifications/AvisosDaOficina.ts: os_orcamento_disponivel (valor + link Minha conta › Meus equipamentos; dedupe por (OS, approval_requested_at); o mesmo valor pedido de novo com o cliente ainda sem responder não duplica), os_pronta (conclusão com custo: valor a pagar na retirada), os_concluida (sem custo com o motivo, ou paga no caixa). Chamados DENTRO das transações de pedirAprovacaoOrcamento, completeTechnical e settleOrder (três linhas no domínio OFI) via queueMensagemPronta (nova em EmailService, contrato "nunca derruba o fato"). O e-mail é o do cadastro vinculado à OS (mesma empresa); sem e-mail não há mensagem e a fala da linha do tempo manda avisar por telefone. Marca: a da bancada (brand_company_id) ou a da empresa. Rota GET /core/workshop/orders/:id/avisos (abertaAo balcão/bancada/escritório + getOrderDetail para o alcance, 404 fora dele). Tela: botão "Pedir aprovação do cliente", selo "pedido em", bloco "Avisos ao cliente" (na fila e por que não saiu, enviado, falhou, cliente sem e-mail). |
| DEPOIS | Existem os modelos os_orcamento_disponivel (valor e link do portal), os_pronta e os_concluida. Eles entram na fila dentro das transações de pedirAprovacaoOrcamento, completeTechnical e settleOrder, pelo contrato 'nunca derruba o fato'. O botão virou 'Pedir aprovação do cliente', e a tela mostra 'Avisos ao cliente' com a situação real de cada aviso. |
| Arquivos | server/src/services/notifications/AvisosDaOficina.ts, server/src/services/notifications/EmailService.ts, server/src/services/core/WorkshopCoreService.ts, server/src/routes/v1/core.ts, server/tests/oficina-avisa-o-cliente.test.ts, server/tests/audit-workshop.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/OrdemServicoPage.tsx, src/pages/gs/__tests__/OrdemServicoFechamento.test.tsx |
| COMMIT | d25407b, f899ec1 |
| TESTES | server/tests/oficina-avisa-o-cliente.test.ts (8 casos): orçamento na fila com valor e link. Sem e-mail, a linha do tempo manda avisar por telefone. Mesmo valor não duplica. Fila quebrada não desfaz o pedido. OS de outra empresa dá 404. Pronta e concluída avisam. O carteiro dublado entrega. OrdemServicoFechamento.test.tsx: botão e 'Avisos ao cliente'. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/notifications/AvisosDaOficina.ts:175-206, :220-254, :261-278, :307-345; server/src/services/core/WorkshopCoreService.ts:1412-1426, :1797, :1862; server/src/routes/v1/core.ts:9454-9465 (abertaAo + getOrderDetail, 404 fora do alcance); src/pages/gs/OrdemServicoPage.tsx:417, :1535, :1587. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A entrega real depende do SMTP (EMAIL_*, ver GAP-PRD-130). WhatsApp e SMS não foram feitos: não há provedor. O e-mail atende o que a ficha espera. |

### GAP-PRD-037 — Não existem e-mails de cancelamento, reembolso, pagamento expirado, entregue nem nota disponível

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | Preço Justo, Gringa, Me Mimei, Conceito, PJ Motors (varejo/e-commerce) / EML |
| ANTES | Só recebido, pago, expedido e pronto para retirada avisavam. Cancelamento (inclusive por prazo vencido), reembolso, pagamento depois do cancelamento, entrega e nota fiscal eram silenciosos. |
| Causa | Só os quatro marcos felizes do pedido tinham modelo; os desfechos (cancelamento, estorno, dinheiro depois do cancelamento, entrega) e a nota fiscal ficavam em silêncio. |
| Correção | Modelos novos em renderEmail (Contexto ganhou origemDoCancelamento, comoOValorVolta, valorRecebidoCents, links e retirada): pedido_cancelado (cliente/loja/prazo — sempre com o "não pague"; prazo com o link para refazer; o motivo digitado pela loja NÃO vai ao cliente), pedido_reembolsado (estorno_confirmado para webhook refunded, contestacao para chargeback, estorno_solicitado quando refundOrder conseguiu o estorno no provedor, devolucao_pela_loja no resto — nunca promete estorno que não existe), pagamento_apos_cancelamento (com o valor, uma vez), pedido_entregue (retirado/entregue, com link do pedido). Enfileirados via enfileirarEmailDoPedido nos escritores existentes, dedupe por (modelo, pedido); cancelOrder ganhou origem (portal = cliente, expiração = prazo, rota do ERP = loja) e markOrderRefunded ganhou comoOValorVolta. nota_disponivel: AvisoDaNotaDoPedido.ts, chamado em FiscalQueueService.applyResponse logo após a transição para AUTHORIZED (o único ponto em que um documento vira autorizado): só modelo 55 de pedido em produção, anexo .zip (ZipWriter) com o nfeProc (montarProcNfe) e o DANFE (renderDanfe) pelo cofre de anexos; sem nProt ou em homologação não vai; nunca lança. |
| DEPOIS | Os modelos novos entram na fila via enfileirarEmailDoPedido, dentro das transações existentes. pedido_cancelado tem origem cliente, loja ou prazo. pedido_reembolsado distingue estorno confirmado, estorno solicitado, contestação e devolução pela loja. Também avisam pagamento_apos_cancelamento e pedido_entregue. nota_disponivel vai com um zip de XML e DANFE, só para NF-e 55 de produção autorizada. |
| Arquivos | server/src/services/notifications/EmailService.ts, server/src/services/notifications/AvisoDaNotaDoPedido.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/OrderChargeService.ts, server/src/services/core/OrderReservationExpiry.ts, server/src/services/core/FiscalQueueService.ts, server/src/routes/v1/storefront.ts, server/tests/pos-venda-avisa-o-cliente.test.ts |
| COMMIT | d25407b, f899ec1 |
| TESTES | server/tests/pos-venda-avisa-o-cliente.test.ts (12 casos): cancelamento pela loja, pelo prazo e pelo portal. Cancelar de novo não duplica. Pagamento depois do cancelamento avisa uma vez. Os três tipos de reembolso têm textos distintos. Retirada entregue avisa uma vez. processNext autoriza e enfileira o zip com procNFe e DANFE. Homologação e protocolo sem nProt não enviam. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/StorefrontService.ts:2079-2081 (cancelamento), :1983-1991 (reembolso), :1859-1864 (pagamento depois do cancelamento), :2328-2336 (entregue); server/src/services/core/OrderReservationExpiry.ts:108-114 (origem 'prazo'); server/src/routes/v1/storefront.ts:1178 (origem 'cliente'); server/src/services/core/OrderChargeService.ts:696; server/src/services/core/FiscalQueueService.ts:406-408; server/src/services/notifications/AvisoDaNotaDoPedido.ts:70-149. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A entrega real depende do SMTP (GAP-PRD-130). O e-mail da nota só sai com NF-e de produção autorizada (certificado A1 e SEFAZ, frente FIS). |

### GAP-PRD-038 — E-mail que falha 5 vezes seguidas morre para sempre: sem backoff, sem reenvio, e a tela não mostra o motivo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / EML |
| ANTES | Cinco falhas seguidas, uma por batida de 60 s, deixavam a mensagem 'failed' para sempre. Não havia rota de reenvio, e a tela não mostrava lastError. |
| Causa | Retry fixo sem espera, failed terminal sem caminho de volta, e a tela sem o motivo. |
| Correção | Coluna nullable core_email_queue.next_attempt_at (DDL canônica; o reconcile acrescenta); espera 1/5/30/120/720 min (ESPERA_ENTRE_TENTATIVAS_MIN) e a sexta falha desiste; o flush só pega pendente cuja hora chegou (relógio injetável só para teste); reenfileirarEmail + POST /core/emails/:id/reenviar (requireProfile gerente_loja/gerente_oficina, companyId do token, 404 para outra empresa, 409 para pendente/entregue/sem conteúdo, auditoria email.requeue com tentativas anteriores e último erro sem senha); GET /core/emails?status=pending\|sent\|failed (400 para filtro inválido) com nextAttemptAt, podeReenviar e motivoSemReenvio; anexo do pacote do contador que falhou retido 30 dias para o reenvio levar o zip. Tela: situação em pt-BR, tentativas, próxima tentativa, motivo, botão Reenviar ou o porquê não, filtro por situação. |
| DEPOIS | A fila espera 1/5/30/120/720 min entre tentativas (next_attempt_at), e só a sexta falha desiste. POST /core/emails/:id/reenviar usa o companyId do token, responde 404 para outra empresa e 409 para pendente, entregue ou sem conteúdo, e é auditado (email.requeue). A tela mostra motivo, tentativas, próxima tentativa, botão Reenviar e filtro por situação. |
| Arquivos | server/src/services/notifications/EmailService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/email-reenvio-com-motivo.test.ts, server/tests/carteiro-existe.test.ts, server/tests/cinco-telas-que-batem-na-cara.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/EmailsPage.tsx, src/pages/gs/__tests__/EmailsPage.test.tsx |
| COMMIT | 6d929ce, 95d1de1 |
| TESTES | server/tests/email-reenvio-com-motivo.test.ts:173-210: espera exata a cada falha, attempts=6 e failed com '535'. Cinco minutos de queda não matam a fila, e ela sai depois. Casos de reenvio: 200 com auditoria, 404 de outra empresa, 409, 403 para o caixa. EmailsPage.test.tsx: motivo, próxima tentativa, Reenviar e filtro. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/notifications/EmailService.ts:1570-1578 (espera entre tentativas), :1855-1856 (só envia pendente cuja hora chegou), :1924-1942 (falha empurra a próxima tentativa, a sexta desiste), :1584-1588 (motivo sem a senha), :1430-1486 (reenfileirarEmail com recordAudit); server/src/routes/v1/core.ts:14185-14224; src/pages/gs/EmailsPage.tsx:107, :141-152, :311-333. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-039 — Não existe cadastro de terminais: cada empresa só abre UMA gaveta por vez e o segundo caixa vende na gaveta do colega

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / MISSING_IMPLEMENTATION |
| Empresa / frente | As seis (toda loja/oficina com mais de um ponto de venda simultâneo; Preço Justo, por ser loja de variedades, é a mais exposta) / PAG |
| ANTES | Não havia cadastro de terminais: uma gaveta por empresa, o segundo caixa recusado ao abrir, e a venda dele caía na gaveta do primeiro. |
| Causa | O cadastro de terminais nunca foi construido: core_terminals sem escritor, TerminalRegistry recusando todo terminalId, e a unicidade "uma gaveta aberta por terminal" reduzida a uma gaveta por empresa (terminal sempre NULL). |
| Correção | TerminalService (criar com codigo <slug>-cx<n>, renomear, desativar com motivo e 409 com gaveta aberta, reativar; nome unico na operacao; 404 entre empresas) e rotas GET/POST /core/terminals, PATCH /core/terminals/:id, POST /core/terminals/:id/deactivate\|activate com auditoria terminal.*; TerminalRegistry.assertTerminalDaEmpresa confere empresa (antes so id) e ativo, terminalDoPedido faz o caixa do token vencer o do corpo (409 CORE_TERMINAL_MISMATCH); openSession abre no caixa, recusa sem caixa quando a operacao tem caixas (400 CORE_TERMINAL_REQUIRED) e nomeia data/quem na recusa de gaveta ja aberta; reopenSession: ultimo turno DESTE caixa; createSale recusa caixa da venda diferente do da gaveta (409 CORE_CASH_SESSION_OTHER_TERMINAL) e herda o caixa da gaveta; GET /core/cash/open devolve terminal/terminalDoDispositivo/terminalRecusado/exigeTerminal/terminaisAtivos. Tela: Configuracoes > Caixas e terminais (TerminaisPage), escolha do caixa no PDV (CaixaDoComputador: EscolhaDoCaixa/LinhaDoCaixa, guardada por computador em gs.pdv.terminal.<empresa>), PDV manda terminalId na consulta, na abertura e na venda, topo nomeia a gaveta; tela de Caixa com escolha do caixa. docs/OPERATIONS.md atualizado. |
| DEPOIS | Existe o CRUD de caixas por empresa, só para a gerência e com auditoria. Abrir gaveta confere empresa e caixa ativo e exige o caixa quando a operação tem caixas cadastrados. O terminal do token vence o do corpo (409 se divergem). A venda de um caixa na gaveta de outro dá 409 CORE_CASH_SESSION_OTHER_TERMINAL. GET /cash/open responde pelo caixa. Tela: Configurações > Caixas e terminais (com emissão e revogação de token do computador) e escolha do caixa no PDV e no Caixa. |
| Arquivos | server/src/services/core/TerminalService.ts, server/src/services/core/TerminalRegistry.ts, server/src/services/core/CashService.ts, server/src/services/core/SalesService.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, server/tests/terminais-e-gaveta-por-caixa.test.ts, server/tests/terminal-sem-cadastro.test.ts, server/tests/audit-caixa.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/terminais.ts, src/lib/api/core.ts, src/components/gs/CaixaDoComputador.tsx, src/components/gs/CaixaPdvDialog.tsx, src/pages/gs/TerminaisPage.tsx, src/pages/gs/PdvPage.tsx, src/pages/gs/OperacaoPages.tsx, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, src/router/__tests__/environments.test.tsx, src/pages/gs/__tests__/pdvCaixaPorTerminal.test.tsx, src/pages/gs/__tests__/terminaisPage.test.tsx, docs/OPERATIONS.md |
| COMMIT | df7aced, ce00afb |
| TESTES | server/tests/terminais-e-gaveta-por-caixa.test.ts: o gerente cria o caixa com auditoria; nome único; o operador lê e não cadastra; desativar exige motivo e caixa fechado; outra operação 404/400; dois operadores com duas gavetas e fechamento independente; venda na gaveta de outro caixa dá 409 sem nada gravado; com caixas cadastrados, abrir sem caixa é recusado; sem caixa cadastrado, a gaveta única continua; token preso ao caixa. Tela: src/pages/gs/__tests__/terminaisPage.test.tsx e src/pages/gs/__tests__/pdvCaixaPorTerminal.test.tsx. Rodados: verdes. |
| EVIDÊNCIA | server/src/services/core/CashService.ts:125-132 (CORE_TERMINAL_REQUIRED), :176-183 (gaveta aberta por terminal); server/src/services/core/TerminalRegistry.ts:41-71 (empresa e ativo), :92-111 (token vence, CORE_TERMINAL_MISMATCH); server/src/services/core/SalesService.ts:678-700; server/src/routes/v1/core.ts:3926-3951 (GET /cash/open pelo caixa), :4015-4110 (rotas /terminals com requireProfile e recordAudit), :4143-4157; src/pages/gs/TerminaisPage.tsx:413-640 (token do computador: emitir, guardar, revogar); src/router/gsRoutes.tsx:347-350; src/components/gs/CaixaDoComputador.tsx:28. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional: o gerente cadastrar os caixas de cada operação. Sem cadastro, a gaveta única de hoje continua. |

### GAP-PRD-040 — Senhas iniciais do seed são compartilhadas, nenhuma nasce provisória, e rodar db:seed de novo reescreve a senha que o dono já trocou

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / SECURITY_RISK |
| Empresa / frente | As seis (13 contas: ADMIN, o gestor do grupo, 6 PDVs, 4 mecânicos, 1 técnico) / SEG |
| ANTES | As contas do seed nasciam com must_change_password=0 e senhas compartilhadas. Rodar db:seed de novo reescrevia a senha já trocada, sem derrubar sessões. |
| Causa | O seed era escrito como atualizacao (upsert) em vez de bootstrap, e criava as contas sem a bandeira de senha provisoria. |
| Correção | seedCoreData vira bootstrap: empresa/conta/vinculo/bancada so sao criados se faltam (empresa existente nao e atualizada; vinculos com ON CONFLICT DO NOTHING); conta existente sem vinculo e completada sem mudar a senha. Contas criadas nascem com must_change_password=1. Producao sem GRUPO_SAMPAIO_*_PASSWORD gera senha aleatoria de 14 caracteres por conta, devolvida uma vez em senhasGeradas e impressa pelo CLI (relatorioDoSeed); senhas de desenvolvimento seguem recusadas em producao; senha informada passa por assertPassword antes de criar qualquer coisa. upsertUser sobe session_version quando a senha muda (verifica antes; mesma senha nao rederiva o hash). Documentos corrigidos: GO_LIVE_CHECKLIST, KNOWN_LIMITATIONS, POST_DEPLOY_CHECKLIST, OPERATIONS, CHECKPOINT, README, .env.production.example. |
| DEPOIS | O seed virou bootstrap. Conta existente é preservada (senha, nome, vínculo, empresa). Conta criada nasce com must_change_password=1. Em produção sem as variáveis, cada conta ganha uma senha aleatória de 14 caracteres, mostrada uma vez. upsertUser sobe session_version quando o hash muda. Com GRUPO_SAMPAIO_*_PASSWORD informadas, os PDVs ainda começam com a mesma senha, mas ela é provisória, o que atende o esperado da ficha. |
| Arquivos | server/src/db/seed.ts, server/src/db/seed-cli.ts, server/src/services/auth/IdentityService.ts, server/tests/seed-nasce-provisorio-e-nao-reescreve.test.ts, docs/audits/remediacao/migracoes/SEG.md, docs/GO_LIVE_CHECKLIST.md, docs/KNOWN_LIMITATIONS.md, docs/POST_DEPLOY_CHECKLIST.md, docs/OPERATIONS.md, docs/CHECKPOINT.md, README.md, .env.production.example |
| COMMIT | 73b42a3 |
| TESTES | server/tests/seed-nasce-provisorio-e-nao-reescreve.test.ts (10 casos). As 13 contas nascem com flag 1 e o PDV recebe 403 API_PASSWORD_CHANGE_REQUIRED. Um segundo seed mantém a senha trocada e a session_version, e o refresh segue vivo. Nome, perfil, CNPJ e regime ficam. Em produção saem 13 senhas distintas e cada uma só abre a própria conta. upsertUser sobe a versão só quando a senha muda. Rodei: verdes. |
| EVIDÊNCIA | server/src/db/seed.ts:186-202 (conta existente preservada), :295-307 (INSERT com must_change_password=1), :156-170 (senha por conta em produção), :130-150 (senha de dev recusada em produção; assertPassword antes de criar); server/src/services/auth/IdentityService.ts:247-265 (session_version+1 só quando a senha muda); server/src/db/seed-cli.ts (imprime relatorioDoSeed); docs/GO_LIVE_CHECKLIST.md:68, docs/KNOWN_LIMITATIONS.md:63. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | No banco operacional, as 13 contas criadas pelo seed antigo seguem com must_change_password=0 (dado declarado; não abri o banco real). Emanuel precisa usar 'Resetar senha' em cada uma, em Usuários e equipe. O caminho existe (TeamService.ts:699 grava a flag e sobe session_version). |

### GAP-PRD-041 — Cadastro fiscal, série, certificado A1 e CSC: só a Preço Justo tem cadastro/série/certificado; CSC em nenhuma; o A1 da PJ vence em 15/10/2026

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Gringa, Me Mimei, Conceito, PJ Motors, Oficina (tudo por fazer); Preço Justo (CSC, catálogo e certificado a renovar em 34 dias) / FIS |
| ANTES | Só a Preço Justo tinha cadastro fiscal, série e certificado. Nenhuma empresa tinha CSC, e o A1 da PJ vence em 15/10/2026. |
| Causa | Dados empresariais, series, certificados A1 e CSC das seis empresas ainda nao foram fornecidos/cadastrados. |
| Correção | Nenhuma mudanca especifica: revalidado. O que este lote mudou no caminho de implantacao (CRT validado e em seletor, item de tributacao no checklist com dono contador) so torna o checklist mais completo — nada passou a exigir codigo. |
| DEPOIS | Todo insumo tem porta por tela/rota, com o companyId do token: cadastro (CRT de 1 a 4), séries, certificado A1 (donos), CSC por ambiente, desbloqueio de produção auditado e NFS-e. O checklist nomeia o responsável de cada pendência, e o aviso de vencimento usa as faixas 90/60/30/15/7. Nenhuma linha falta. |
| Arquivos | — |
| COMMIT | — |
| TESTES | server/tests/empresa-nova-sem-codigo.test.ts: a caminhada criar → configurar → certificado → Asaas → série → prontidão → vender; gerente não abre operação; empresa nova nunca usa o certificado ou o CSC da vizinha. Rodei: verde. A remediação não cita commits nesta ficha (commits: []), e nenhum commit exige verificação. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:4342 (POST /fiscal/certificate), 4483 (POST /fiscal/nfce/csc), 7618 (PATCH /fiscal/config), 7823 (POST /fiscal/production-unlock), 8697 (POST /fiscal/series); server/src/services/core/CertificateStatusService.ts:39; server/src/services/core/FiscalConfigService.ts:424-475, 559-625 (itens do checklist com dono) |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel: CNPJ, IE, CRT e endereço com IBGE/CEP de Gringa, Me Mimei, Conceito, PJ Motors e Oficina; séries 55/65; A1 de cada CNPJ; renovar o A1 da Preço Justo antes de 15/10/2026; CSC de homologação e produção de cada CNPJ; grupo tributário com o contador; emitir em homologação e desbloquear produção. |

### GAP-PRD-042 — O caixa da Oficina (operador_caixa_oficina) não tem tela para receber a OS — a ficha da OS o devolve ao /pdv e o PDV não lista OS aguardando pagamento

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / INCONSISTENT_CONTRACT |
| Empresa / frente | oficina / OFI |
| ANTES | O operador_caixa_oficina era mandado de volta ao /pdv ao abrir a ficha da OS. O PDV não consumia GET /workshop/pending-payment, então o único perfil de balcão autorizado a receber não tinha tela com o botão Receber. |
| Causa | a unica tela com o gesto de receber era a ficha da OS, que o ambiente pdv nao abre; a fila existia so no servidor |
| Correção | botao "OS a receber (N)" no PDV (so para operador_caixa_oficina/gerente_oficina/donos e so com temOficina) abrindo OsAReceberDialog (lista com busca por numero/cliente/aparelho/placa) e RecebimentoOsDialog; GET /workshop/pending-payment reescrita sobre WorkshopCashierService.filaDeRecebimento (searchOrders com resolveWorkshopScope, status no banco, cliente/aparelho/bancada/mecanico, total, temOficina, faturamentoAPrazo); a trava de gaveta fechada do PDV vale para receber OS; o recebimento aparece no painel do comprovante do PDV |
| DEPOIS | O PDV carrega a fila para operador_caixa_oficina e gerente_oficina e mostra 'OS a receber (N)' quando a empresa tem bancada. O botão respeita a trava de gaveta e abre OsAReceberDialog, que leva ao RecebimentoOsDialog. A rota lê a fila no banco, com cliente, aparelho, bancada e total. |
| Arquivos | server/src/services/core/WorkshopCashierService.ts, server/src/routes/v1/core.ts, src/lib/api/oficinaCaixa.ts, src/components/gs/OsAReceberDialog.tsx, src/components/gs/RecebimentoOsDialog.tsx, src/pages/gs/PdvPage.tsx, server/tests/caixa-da-oficina.test.ts, src/pages/gs/__tests__/caixaDaOficina.test.tsx |
| COMMIT | 411f040 |
| TESTES | server/tests/caixa-da-oficina.test.ts bloco GAP-PRD-042 (3): caixa sem vínculo de bancada lê a fila com customer_display, total e workshop_name; mecânico 403; empresa sem oficina tem temOficina=false. src/pages/gs/__tests__/caixaDaOficina.test.tsx bloco GAP-PRD-042 (3): caixa da oficina recebe pela fila com split e desconto; caixa da loja não vê o botão; empresa sem bancada não vê o botão. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:10071-10079; server/src/services/core/WorkshopCashierService.ts:68-91; src/pages/gs/PdvPage.tsx:545-559, 2903-2918, 3561-3563; src/components/gs/OsAReceberDialog.tsx:38-74 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-043 — Cliente NOVO da loja, logado, faz um pedido e não o vê em 'Meus pedidos' — o checkout não liga o cadastro à conta e a tela não tem o controle de vincular

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P1 / BUG |
| Empresa / frente | preco-justo, gringa, me-mimei, conceito, pj-motors / ECO |
| ANTES | Cliente novo e logado fazia pedido e não o via em 'Meus pedidos': o checkout ignorava a sessão do portal e não ligava o cadastro à conta. |
| Causa | POST /loja/checkout era rota publica que nao lia a sessao do portal; o cadastro criado nao era ligado a conta; a visibilidade do pedido dependia de vinculo por CPF. |
| Correção | A rota le o x-portal-token (token vencido = 401, nunca vira visitante); prepararComprador confere a conta; o pedido nasce com customer_account_id e o e-mail provado da conta; cadastroDaConta acha/cria o cadastro da operacao e liga (proof checkout/coprova/email). filtroDoDono mostra o pedido da conta na hora e o de visitante feito com o e-mail provado. Tela: LojaPage envia o token do portal (CompradorDaConta/EnderecoDaConta), MinhaContaPage ganhou "Trazer minhas compras pelo CPF" (/portal/vincular, que agora devolve quantos vinculos nasceram). |
| DEPOIS | POST /loja/checkout lê o x-portal-token (token inválido dá 401, não vira visitante). O pedido nasce com customer_account_id e o e-mail provado, e o cadastro é criado e ligado à conta. filtroDoDono mostra o pedido na hora. A tela envia o token e tem 'Trazer minhas compras pelo CPF'. |
| Arquivos | server/src/routes/v1/storefront.ts, server/src/services/core/CheckoutIdentityService.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/CustomerPortalService.ts, src/pages/gs/LojaPage.tsx, src/components/gs/CheckoutDaConta.tsx, src/components/gs/TrazerMinhasCompras.tsx, src/pages/gs/MinhaContaPage.tsx, server/tests/checkout-exige-conta.test.ts, src/pages/gs/__tests__/checkoutComConta.test.tsx, src/components/gs/__tests__/trazerMinhasCompras.test.tsx |
| COMMIT | 9d3c286, 7893a43 |
| TESTES | server/tests/checkout-exige-conta.test.ts, bloco GAP-PRD-043 (:125-195: cliente novo logado vê o pedido na hora; e-mail provado no pedido e cadastro ligado; duas lojas; segunda compra usa o mesmo cadastro). Tela: checkoutComConta.test.tsx e trazerMinhasCompras.test.tsx. Rodado: verde. |
| EVIDÊNCIA | server/src/routes/v1/storefront.ts:649-675; CheckoutIdentityService.ts:456-545 (liga com proof checkout/coprova/email); CustomerPortalService.ts:1254-1263 (o.customer_account_id = ?); src/pages/gs/LojaPage.tsx:757-758 (header x-portal-token); MinhaContaPage.tsx:631. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-044 — Servidor da loja caído: a fila offline do PDV não reenvia sozinha (navigator.onLine não detecta servidor fora) e não existe retentativa periódica

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas as seis / PAG |
| ANTES | Com o servidor da loja caído e a rede de pé, a fila offline só reenviava por clique em 'Enviar agora'; navigator.onLine não percebia o servidor fora. |
| Causa | O gatilho do reenvio era o evento online do navegador, que mede a rede do computador e nao o servidor da loja; nao havia sonda do servidor nem retentativa periodica. |
| Correção | EstadoConexao reescrito: enquanto houver fila, tentativa automatica com espera 5 s, 10 s, 20 s e dai a cada 30 s (esperaDaTentativa em offlineQueue.ts), sondando GET /api/v1/health (sondarServidor em src/lib/api/vendasOffline.ts, prazo 4 s) antes de reenviar; a barra distingue 'Este computador esta sem rede' de 'O servidor da loja nao responde — a rede deste computador esta de pe'; navegador reaberto com fila tenta na primeira janela; trava de modulo contra dois envios simultaneos; 'Enviar agora' continua. offlineQueue: classificarFalha (rede/sessao/recusa), lastErrorKind/lastErrorCode/lastAttemptAt e o desfecho 'encaminhada' em flushQueue. Procedimento em docs/OPERATIONS.md ('Servidor da loja fora do ar'). |
| DEPOIS | Enquanto houver fila, a barra tenta sozinha em 5, 10 e 20 s e depois a cada 30 s. Antes de reenviar, sonda GET /api/v1/health com prazo de 4 s. A barra distingue 'sem rede' de 'o servidor da loja não responde'. O navegador reaberto tenta na primeira janela. O reenvio usa a mesma Idempotency-Key. |
| Arquivos | src/components/gs/EstadoConexao.tsx, src/lib/api/offlineQueue.ts, src/lib/api/vendasOffline.ts, src/components/gs/__tests__/filaSobeSozinha.test.tsx, src/lib/api/__tests__/offlineQueue.test.ts, docs/OPERATIONS.md |
| COMMIT | 5eafd3b |
| TESTES | src/components/gs/__tests__/filaSobeSozinha.test.tsx: com o servidor fora e a rede de pé a barra fala do servidor e nenhum POST sai; o servidor volta e a venda sobe sem clique; o navegador reaberto sobe na primeira tentativa; a espera cresce e para em 30 s; classificação da falha. src/components/gs/__tests__/filaDizPorQueFalhou.test.tsx e src/lib/api/__tests__/offlineQueue.test.ts. Rodados: verdes. |
| EVIDÊNCIA | src/components/gs/EstadoConexao.tsx:90-190 (enviarPendentes com sonda e agendamento automático), :223-229 (mensagens distintas); src/lib/api/vendasOffline.ts:92-104 (sondarServidor em /api/v1/health); src/lib/api/offlineQueue.ts:190-192 (esperaDaTentativa limitada a 30 s). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-045 — Venda guardada na fila offline é recusada para sempre se o caixa daquele turno já fechou ou o estoque acabou — dinheiro já recebido, sem caminho de regularização na tela

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DATA_INTEGRITY_RISK |
| Empresa / frente | Todas as seis / PAG |
| ANTES | Uma venda offline recusada no reenvio (caixa do turno fechado, estoque acabado) ficava presa na fila do navegador para sempre, com o dinheiro já recebido e sem regularização na tela. |
| Causa | A fila offline so sabia reenviar; a recusa definitiva nao tinha destino alem do lastError local, e nenhum caminho reusava a mesma chave numa gaveta aberta. |
| Correção | Tabela core_offline_sale_pendings (DDL canonica, UNIQUE empresa+chave, indice na mesma DDL, ordem de exclusao). VendasOfflineRecusadas: registrar idempotente pela chave (venda ja existente devolve jaSubiu), listar com produto/caixa/quem, relancar pelo mapeamento de POST /sales extraido para vendaDoCorpo (MESMA chave, gaveta aberta de quem relanca; a recusa fica guardada na pendencia), concluir com trilha sale.offline.regularized (gaveta original, nova, queuedAt, valor), descartar so pela gerencia com motivo e trilha sale.offline.discarded. Rotas GET/POST /core/offline-sales, POST /core/offline-sales/:id/relaunch (balcao, a alcada de POST /sales) e /discard (gerencia). A venda recusada de gaveta ainda aberta entra em pendenciasEletronicasDoTurno.vendasOffline: o fechamento exige ciencia e motivo e a frase a nomeia. Tela: a barra entrega a recusa definitiva e a tira do navegador; Regularizar (RegularizarVendasOffline) relanca na gaveta aberta DESTE computador, a recusa de estoque nomeia o produto e aponta Estoque > Movimentacoes, sem gaveta aberta pede para abrir, descartar so para a gerencia; PendenciasDoFechamento lista a venda recusada; CaixaPdvDialog nao fecha a gaveta com venda deste computador na fila. |
| DEPOIS | A recusa definitiva é entregue ao servidor como pendência (UNIQUE empresa+chave) e sai do navegador. Relançar usa a mesma chave na gaveta aberta de quem relança, com a alçada de POST /sales. A recusa de estoque fica guardada e nomeia o produto. Descartar é só da gerência, com motivo e trilha. O fechamento da gaveta com venda recusada exige ciência e motivo, e o CaixaPdvDialog não fecha com fila local. A venda relançada nasce com a data atual; a hora original fica na pendência (queuedAt). |
| Arquivos | server/src/db/schema.ts, server/src/services/core/VendasOfflineRecusadas.ts, server/src/services/core/PendenciasDoTurno.ts, server/src/services/core/CashService.ts, server/src/routes/v1/core.ts, server/tests/vendas-offline-recusadas.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/vendasOffline.ts, src/lib/api/core.ts, src/components/gs/EstadoConexao.tsx, src/components/gs/RegularizarVendasOffline.tsx, src/components/gs/PendenciasDoFechamento.tsx, src/components/gs/CaixaPdvDialog.tsx, src/components/gs/__tests__/filaSobeSozinha.test.tsx |
| COMMIT | 5eafd3b |
| TESTES | server/tests/vendas-offline-recusadas.test.ts: caixa fechado vira pendência; relançar vende uma vez com a mesma chave, e relançar de novo dá 409; estoque recusa com motivo e passa depois da entrada; descarte só da gerência, com motivo; outra empresa 404; mecânico 403; fechamento com venda recusada exige ciência. src/components/gs/__tests__/filaSobeSozinha.test.tsx: entrega, Regularizar, estoque pelo nome, sem gaveta, descarte só da gerência, o botão de fechar espera a fila. Rodados: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:5620-5723 (GET/POST /offline-sales, relaunch com a mesma chave e o cashSessionId novo, discard só para a gerência); server/src/services/core/VendasOfflineRecusadas.ts:215-298 (registrar com auditoria), :358-399 (concluir com trilha), :401-450 (descartar com motivo), :452 (pendências da gaveta); src/components/gs/EstadoConexao.tsx:117-142 (entrega a recusa), :250-273 (Regularizar); src/components/gs/RegularizarVendasOffline.tsx:47; src/components/gs/CaixaPdvDialog.tsx:291-294 e :754. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-046 — Fila offline é por navegador (localStorage): invisível ao gestor e a outros caixas; perde-se com a máquina do PDV

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas as seis / PAG |
| ANTES | A fila offline mora no localStorage de cada navegador, invisível ao gestor, e se perde com a máquina. A documentação sugeria um cliente offline mais amplo do que existe. |
| Causa | A arquitetura (servidor da loja como ponto unico) nunca foi registrada como decisao, os textos sugeriam offline-first e a venda recusada ficava presa num unico navegador. |
| Correção | O que era software foi feito: a venda recusada vira pendencia do servidor (GAP-PRD-045) — visivel ao gestor e a todos os caixas e fora do risco da maquina do caixa —, o reenvio sobe sozinho (GAP-PRD-044) e a barra diz o que parou. A decisao ficou registrada em docs/ESTADO-ATUAL.md ('Servidor da loja: ponto unico'), os textos foram corrigidos (docs/ARQUITETURA-NUCLEO.md e a linha Offline do ESTADO-ATUAL) e o procedimento esta em docs/OPERATIONS.md ('Servidor da loja fora do ar'). |
| DEPOIS | A parte de software da opção (a) está feita: reenvio automático (GAP-PRD-044) e a recusa virando pendência do servidor, visível a todos (GAP-PRD-045). A decisão está registrada em docs/ESTADO-ATUAL.md, que adota (a) como proteção vigente e deixa (b) como decisão pendente do dono. O texto de arquitetura foi corrigido ('fila offline SÓ da venda do PDV'), e o procedimento está em docs/OPERATIONS.md. O limite restante é a venda que ainda não subiu, que continua no navegador do caixa. |
| Arquivos | docs/ESTADO-ATUAL.md, docs/ARQUITETURA-NUCLEO.md, docs/OPERATIONS.md |
| COMMIT | 5eafd3b |
| TESTES | Os de GAP-PRD-044 e GAP-PRD-045 (filaSobeSozinha, vendas-offline-recusadas), rodados e verdes. A decisão em si não tem teste. |
| EVIDÊNCIA | docs/ESTADO-ATUAL.md:376 (linha Offline corrigida), :380-404 (Servidor da loja: ponto único, opções a e b); docs/ARQUITETURA-NUCLEO.md:23 (texto corrigido); docs/OPERATIONS.md:53-74 (procedimento com o servidor fora); o README não promete fila offline (grep sem ocorrência). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| O que falta | Nada para a opção (a), que já está implementada e documentada. A opção (b), offline-first com banco local por caixa e sincronização, não está implementada: a própria ficha a classifica como projeto novo, fora da correção pedida. |
| Insumo externo | Emanuel confirmar a opção (a): nobreak no servidor da loja e backup diário mantido. Ou pedir (b), que abre um projeto novo. |

### GAP-PRD-047 — Central fora do ar por ~25 min de tentativas contínuas leva a fila inteira a 'dead' — reviver é clique manual

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas as seis (fila do nó) / DEP |
| ANTES | Com a central fora do ar por cerca de 25 min, a fila inteira virava dead depois de 12 tentativas. Reviver dependia de clique manual. |
| Causa | marcarFalha contava toda falha contra MAX_ATTEMPTS, sem distinguir central fora do ar de recusa, e o lote era julgado inteiro. |
| Correção | OutboxService: NaturezaDaFalha (TRANSPORTE \| RECUSA), FalhaDaCentral e naturezaDaFalha (desconhecido = RECUSA, a regra antiga). marcarFalha: TRANSPORTE nunca vira dead e espera no máximo 10 min; RECUSA segue com o limite de 12 e devolve quantos morreram. core_outbox.last_error_kind (DDL canônica, anulável); o retrato ganha lastErrorKind e esperandoCentral. SyncService: supabaseTransport classifica na origem (rede e 5xx/408/429 = transporte; outro 4xx = recusa), sem a chave na mensagem; syncOnce entrega por entregarIsolando (lote de vários recusado vai um a um, só o envenenado ganha tentativa; se a central cair no meio, o resto espera como transporte); evento que vira dead sai no log (CENTRAL_SYNC_EVENTO_PARADO). |
| DEPOIS | A falha é classificada na origem. Rede, 5xx, 408 e 429 são TRANSPORTE: nunca viram dead e esperam no máximo 10 min. Outros 4xx são RECUSA: seguem o limite de 12. Um lote recusado é isolado evento a evento. O status expõe lastErrorKind e a tela mostra a natureza da falha. |
| Arquivos | server/src/services/sync/OutboxService.ts, server/src/services/sync/SyncService.ts, server/src/db/schema.ts, server/tests/central-fora-do-ar-nao-mata-a-fila.test.ts |
| COMMIT | 933d2c3, 032a368 |
| TESTES | server/tests/central-fora-do-ar-nao-mata-a-fila.test.ts: rede caída muito além do limite continua retry; 503 é transporte com espera limitada a 10 min; 429/408 são transporte; a central volta e o evento sobe sem clique; 400 doze vezes vira dead; lote recusado por um evento não mata os outros; a mensagem não leva a chave. Rodei: verde. |
| EVIDÊNCIA | server/src/services/sync/OutboxService.ts:58-61 (MAX_ATTEMPTS, ESPERA_MAXIMA_TRANSPORTE_MS=10 min), 102-115 (naturezaDaFalha), 415-450 (marcarFalha: dead só quando RECUSA e tentativas>=12); server/src/services/sync/SyncService.ts:309-322 (FalhaDaCentral TRANSPORTE/RECUSA por status), 670; src/pages/gs/SincronizacaoPage.tsx:384-386 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-048 — Não é possível provar, pela API ou pela tela, que a projeção na central real está funcionando: o diagnóstico de projeção é escrito e nunca lido, e o banco operacional ainda guarda o erro PGRST202 (RPC não encontrada)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UNABLE_TO_PROVE |
| Empresa / frente | Todas as seis / DEP |
| ANTES | central_projection_last_error era escrito e nunca lido. Nada distinguia um PGRST202 fóssil de uma RPC que continua faltando. |
| Causa | O diagnóstico de projeção era gravado sem hora e sem leitor; a reprojeção administrativa (o outro caminho que projeta) não passava por ele; e nada perguntava à central se a função de projeção existe. |
| Correção | SyncService: diagnosticoDaProjecao, registrarErroDeProjecao e registrarProjecaoAceita (chaves central_projection_last_error, central_projection_last_error_at, central_projection_last_ok_at; o erro novo não apaga a última aceita), syncOnce passa por elas e syncStatus.projecao sai em GET /core/sync/status. services/sync/conferenciaDaProjecao.ts: conferirRpcDeProjecao chama rpc/erp_apply_projections com payload vazio (a função percorre o array e não grava nada) e responde PRONTA, AUSENTE (PGRST202, aponta docs/supabase/03-projecao.sql), RECUSADA ou SEM_RESPOSTA, sem a chave no texto. conferir-central.js mostra a sonda e o diagnóstico local e reprova o veredito sem a função; reprojetar-central.js registra aceite e falha. SincronizacaoPage: bloco da projeção (erro com hora, ou "data desconhecida" para o registro antigo sem hora; última aceita) e a natureza da última falha de envio (TRANSPORTE/RECUSA do GAP-PRD-047). Antes, em commit próprio (032a368), a correção do 933d2c3: o byte NUL literal em agruparFalhas virou o escape \u0000 (mesmo valor em execução) e o SyncService.ts volta a ser gravado com LF — o NUL fazia o git tratá-lo como binário e o blob tinha virado CRLF inteiro (diff de 1.397 linhas contra a base, conflito certo na junção). |
| DEPOIS | syncStatus.projecao, via GET /core/sync/status, entrega o último erro com hora e a última projeção aceita. O envio normal e a reprojeção gravam e limpam as chaves. conferir-central sonda a RPC com lote vazio (PRONTA/AUSENTE/RECUSADA/SEM_RESPOSTA) e reprova o veredito sem ela. A tela Sincronização mostra o bloco da projeção. |
| Arquivos | server/src/services/sync/SyncService.ts, server/src/services/sync/conferenciaDaProjecao.ts, server/src/scripts/conferir-central.ts, server/src/scripts/reprojetar-central.ts, server/tests/a-projecao-se-mostra.test.ts, src/pages/gs/SincronizacaoPage.tsx, src/pages/gs/__tests__/SincronizacaoPage.test.tsx |
| COMMIT | b004f4f |
| TESTES | server/tests/a-projecao-se-mostra.test.ts: sem nada, nulos; falha aparece com a hora; volta limpa o erro e grava a aceita; GET /core/sync/status entrega o diagnóstico; reprojeção limpa e registra; sonda PRONTA com lote vazio, AUSENTE em PGRST202, SEM_RESPOSTA sem vazar a chave, RECUSADA com o código. src/pages/gs/__tests__/SincronizacaoPage.test.tsx. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/sync/SyncService.ts:430-477 (três chaves, diagnóstico, registrar erro/aceita), 253 (projecao no syncStatus), 705-755 (syncOnce registra erro e aceite); server/src/services/sync/conferenciaDaProjecao.ts:37-93; server/src/scripts/conferir-central.ts:125-136 e 222-232 (veredito exige rpc PRONTA); server/src/scripts/reprojetar-central.ts:437-439; server/src/routes/v1/core.ts:13581-13596; src/pages/gs/SincronizacaoPage.tsx:432-470 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Com a credencial real da central: rodar node server/dist/scripts/conferir-central.js e ler PROJECTION RPC. Se AUSENTE, aplicar docs/supabase/03-projecao.sql e rodar reprojetar-central --confirmar. Não verifiquei o estado da central real nem o banco da loja: é proibido nesta reauditoria. |

### GAP-PRD-049 — Asaas com timeout: a intenção fica 'failed' sem provider_ref e a retentativa cria uma SEGUNDA cobrança no provedor

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DATA_INTEGRITY_RISK |
| Empresa / frente | Todas as seis (cada uma com conta Asaas própria) / FIN |
| ANTES | Um timeout na criação deixava a intenção 'failed' sem provider_ref, e a retentativa criava uma segunda cobrança no Asaas. O webhook da cobrança órfã caía em 'Cobrança não encontrada'. |
| Causa | timeout na criacao tratado como falha definitiva; externalReference enviado mas nunca consultado; webhook casava so por provider_ref |
| Correção | AsaasHttpClient.listPayments; modulo AsaasCobrancaOrfa (procurarCobrancaJaCriada por externalReference+meio+valor+viva+nao vinculada, falha da consulta = ASAAS_CONSULTA_INCERTA, motivo de resultado incerto, cancelarCobrancasOrfas); requestAsaasCharge na retentativa consulta e adota (adotarCobrancaDoProvedor, que aplica a confirmacao se a orfa ja estiver paga) e, consulta falhou, nao cria; createOrderCharge registra a falha como failed (+attempts) e, com intencao existente sem referencia, consulta e adota antes de criar; webhook casa a orfa pela referencia externa dentro da operacao (uma candidata, mesmo meio); cancelFinanceEntryCharges/cancelOrderCharges procuram e cancelam a orfa no provedor e nao dao como cancelada quando a consulta falha (titulo) |
| DEPOIS | Na retentativa (createPaymentIntent → requestAsaasCharge com retentativa, e createOrderCharge), o sistema consulta GET /payments?externalReference=originId e adota a cobrança que já existe (mesmo meio, valor, viva, sem vínculo). Se a consulta falhar, não cria nada. O webhook casa a órfã pela referência externa dentro da operação. Cancelar título ou pedido procura e cancela a órfã no provedor. |
| Arquivos | server/src/services/asaas/AsaasHttpClient.ts, server/src/services/core/AsaasCobrancaOrfa.ts, server/src/services/core/PaymentService.ts, server/src/services/core/OrderChargeService.ts, server/src/services/core/FinanceChargeService.ts, server/tests/cobranca-timeout-sem-segunda.test.ts |
| COMMIT | 3161eba |
| TESTES | server/tests/cobranca-timeout-sem-segunda.test.ts (12 casos): timeout → failed com 'pode ter sido criada'; a retentativa adota (criacoes()=1, consulta com externalReference, provider_ref igual ao da órfã); sem cobrança lá, cria; consulta muda → 0 criações e failed; órfã já paga → adota e baixa 30000; o webhook da órfã casa e baixa; a referência não atravessa empresas; meio diferente não é adotado; o pedido online não cobra duas vezes; o cancelamento cancela a órfã lá. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/PaymentService.ts:340-346, 474-494 (pergunta antes de criar), 525-531 (texto de resultado incerto), 928-956 (órfã no webhook, filtrada por company_id), 1604-1610; server/src/services/core/AsaasCobrancaOrfa.ts:89-93, 132-184, 207-233; server/src/services/core/OrderChargeService.ts:203-237, 281-291; server/src/services/core/FinanceChargeService.ts:546-564 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-050 — Devolução parcial repetida acumula resíduo de arredondamento e ultrapassa o valor da linha

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | Todas as seis / PAG |
| ANTES | Cada devolução parcial arredondava sozinha: linha de 2999 devolvida 1+1+1 somava 3000. |
| Causa | Cada devolucao parcial arredondava round(total * qtd / vendida) sozinha, sem olhar o valor ja devolvido da linha. |
| Correção | valorDaParcelaDevolvida: alvo = liquido * (ja devolvido + qtd) / vendida, arredondado (ou o liquido inteiro quando esgota a linha), menos o valor ja devolvido da linha; nunca negativa, nunca acima do liquido. jaDevolvido devolve quantidade e centavos. Vale tambem para a mesma linha repetida no mesmo pedido. A tela usa a mesma conta. |
| DEPOIS | O valor da parcela é calculado sobre o acumulado: o líquido vezes (já devolvido + quantidade) sobre o vendido, arredondado, menos o que já voltou em dinheiro. A devolução que esgota a linha devolve exatamente o resto. Nunca fica negativa nem passa do líquido. jaDevolvido passou a somar quantidade e centavos. Vale também para a mesma linha repetida no mesmo pedido. |
| Arquivos | server/src/services/core/SaleReturnService.ts, server/tests/devolucao-devolve-o-que-entrou.test.ts, server/tests/dinheiro-em-centavos-exatos.test.ts, src/lib/valorDaDevolucao.ts, src/pages/gs/DevolucoesPage.tsx, src/pages/gs/__tests__/devolucaoDevolveOQueEntrou.test.tsx |
| COMMIT | 96fcb09, 089fc5e |
| TESTES | server/tests/devolucao-devolve-o-que-entrou.test.ts: 1+1+1 de 2999 dá [1000, 999, 1000], soma 2999 e saídas 2999; 3+3 de 1001 dá 501+500, em dois pedidos e no mesmo pedido. server/tests/dinheiro-em-centavos-exatos.test.ts. Tela: src/pages/gs/__tests__/devolucaoDevolveOQueEntrou.test.tsx (a última fração anuncia R$ 10,00). Rodados: verdes. |
| EVIDÊNCIA | server/src/services/core/SaleReturnService.ts:159-167 (jaDevolvido com quantidade e centavos), :245-258 (valorDaParcelaDevolvida), :413-434 (uso por linha dentro da transação). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-051 — Pacote do contador imprime a data UTC do documento no manifesto e nos CSVs

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | Todas as seis / FIS |
| ANTES | O pacote do contador recortava o mês pelo dia da loja, mas imprimia a data como fatia do instante UTC. A nota das 21h30 de 31/08 saía datada 01/09. |
| Causa | Data impressa por fatia do instante UTC; o recorte do mes ja era o dia da loja. |
| Correção | diaDoPacote (diaDaLoja; vazio continua vazio, data de calendario passa como veio, valor que nao e data volta cortado como antes) nas seis ocorrencias; o 'Gerado em' do LEIA-ME sai na hora da loja com o fuso escrito (America/Sao_Paulo). |
| DEPOIS | As seis ocorrências passam por diaDoPacote, que usa diaDaLoja (America/Sao_Paulo). O 'Gerado em' do LEIA-ME sai na hora da loja, com o fuso escrito. Não sobrou nenhum slice(0,10) de data no serviço. |
| Arquivos | server/src/services/core/FiscalClosingService.ts, server/tests/pacote-do-contador-dia-da-loja-e-integridade.test.ts |
| COMMIT | 1ef9f6f |
| TESTES | server/tests/pacote-do-contador-dia-da-loja-e-integridade.test.ts:195-255: nota, nota sem procNFe, cancelamento, entrada e faixa inutilizada (no manifesto e no CSV) às 21h30 de 31/07 saem 2026-07-31 e nunca 2026-08-01; o LEIA-ME não diz mais '(UTC)'. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/FiscalClosingService.ts:888-894 (diaDoPacote), :965, :978, :1027, :1069, :1220, :1279 (usos), :1453 (Gerado em com FUSO_DA_LOJA); CalendarioOperacional.ts:153 (diaDaLoja). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-052 — Caixa altera produto (preço/custo) por PUT /products/:id direto na API, enquanto GET /products o recusa e nenhuma tela do balcão oferece isso

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas as seis (operador_caixa_loja e operador_caixa_oficina existem no banco real) / SEG |
| ANTES | PUT /products/:id aceitava operador_caixa_loja/_oficina. O caixa podia mudar preço e custo de tabela pela API, sem passar pela alçada. |
| Causa | A lista do requireProfile do PUT do cadastro incluia os dois caixas com a justificativa "corrigir preco e trabalho de balcao", sem fluxo de tela que precisasse disso. |
| Correção | PUT /products/:id passa a exigir quem responde pelo cadastro (AUX_EDITORES: gerente_loja, gerente_oficina, estoquista; admin_geral e gestor pelo atalho). Comentario da rota reescrito com o motivo. produto-tipo passa a esperar 403 do caixa (antes 409 no corpo); audit-pdv inativa o produto com o gerente, como o proprio comentario do teste dizia. |
| DEPOIS | PUT /products/:id exige AUX_EDITORES (gerente_loja, gerente_oficina, estoquista), mais admin_geral e gestor pelo atalho. Para o caixa, é 403 antes de procurar o produto. O comentário da rota diz o motivo. POST /products (produto novo) segue aberto ao caixa e não altera item existente. |
| Arquivos | server/src/routes/v1/core.ts, server/tests/cadastro-de-produto-nao-e-do-caixa.test.ts, server/tests/produto-tipo.test.ts, server/tests/audit-pdv.test.ts |
| COMMIT | 91bb7c8 |
| TESTES | server/tests/cadastro-de-produto-nao-e-do-caixa.test.ts: para os dois caixas, PUT = 403 API_PERMISSION_DENIED com price_cents e cost_cents intactos. Produto inexistente dá 403 (não 404). Gerentes e estoquista seguem com 200. Atendente e mecânico, 403. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:2779-2781 (requireProfile(req, ...AUX_EDITORES)); core.ts:1975 (AUX_EDITORES = gerente_loja, gerente_oficina, estoquista); comentário em core.ts:2766-2777. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-053 — Access token de 1 hora continua valendo após desativação, rebaixamento ou desvínculo (decisão documentada)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / SEG |
| ANTES | authMiddleware só conferia a assinatura do JWT. Desativado, rebaixado ou desvinculado seguia com 200 por até 1 h, e a tela de equipe não avisava. |
| Causa | O access JWT de 1 h nao era conferido contra a conta a cada requisicao; a janela estava documentada como decisao (ApiAuthService 'A janela que fica') e a tela de equipe nao dizia nada ao gestor. |
| Correção | Decisao do dono resolvida pelo lado seguro, sem alavanca a escolher: services/auth/ContaDaSessao.ts confere em toda rota autenticada (authMiddleware e autenticacaoDaEtapaDeTroca) conta ativa, session_version do token igual a da conta e vinculo com a operacao do token (uma consulta por chave primaria, preparada uma vez por conexao); recusa 401 API_SESSION_ENDED, e o cliente cai no login pelo refresh, que faz as mesmas perguntas. O perfil que vale e o do vinculo de agora (rebaixamento e promocao na requisicao seguinte; GET /auth/session devolve o perfil em vigor); quando difere do token, a resposta traz X-Perfil-Em-Vigor (exposto no CORS) e src/lib/api/client.ts atualiza a sessao guardada para o menu acompanhar. EquipePage diz QUANDO o corte vale (Desativar, Resetar senha, Remover desta operacao, perfil no Editar). Testes das rotas legadas que fabricavam sessao de conta inexistente passam a usar server/tests/helpers/sessao.ts (provisiona a conta, a empresa e o vinculo que a sessao afirma). |
| DEPOIS | A decisão foi tomada pelo lado seguro, sem opção a escolher. Toda rota autenticada confere no banco: conta ativa, session_version igual e vínculo com a operação. Se algo falha, dá 401 API_SESSION_ENDED. O perfil que vale é o do vínculo atual (header X-Perfil-Em-Vigor). verifyAccessToken só é chamado no middleware. A EquipePage diz que o corte vale na hora. |
| Arquivos | server/src/services/auth/ContaDaSessao.ts, server/src/middleware/auth.ts, server/src/app.ts, server/src/services/api/ApiAuthService.ts, server/src/services/core/TeamService.ts, server/src/routes/v1/auth.ts, src/lib/api/client.ts, src/pages/gs/EquipePage.tsx, src/components/gs/TrocaDeSenhaProvisoria.tsx, docs/ESTADO-ATUAL.md, docs/audits/remediacao/migracoes/SEG.md, server/tests/corte-imediato-do-acesso.test.ts, server/tests/helpers/sessao.ts, server/tests/senha-propria-e-terminal-revogavel.test.ts, server/tests/fechamento-contador.test.ts, server/tests/prompt27-security-identity.test.ts, server/tests/{asaas-integration,automations,bi-decorativo-sai-do-ar,crm,integrations,payment-terminals,prompt15..19,prompt25,prompt26,prompt29,prompt30,system-admin}.test.ts (so o import de issueSession), src/pages/gs/__tests__/equipeCorteImediato.test.tsx, src/lib/api/__tests__/perfilEmVigor.test.ts |
| COMMIT | 4ec2ce2, ed2a420 |
| TESTES | server/tests/corte-imediato-do-acesso.test.ts (12 casos). [C1] desativado: o mesmo token dá 401 API_SESSION_ENDED. [C2] rebaixado: 403 com x-perfil-em-vigor=atendente, e /auth/session devolve o perfil novo. [C4] desvinculado: 401. Reset da gestão, troca da própria senha e terminal do PDV cortam na hora. src/pages/gs/__tests__/equipeCorteImediato.test.tsx e src/lib/api/__tests__/perfilEmVigor.test.ts. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/auth/ContaDaSessao.ts:87-105; server/src/middleware/auth.ts:57-69 (conferirContaDaSessao em authMiddleware e autenticacaoDaEtapaDeTroca); grep: verifyAccessToken só em middleware/auth.ts:57; src/pages/gs/EquipePage.tsx:426, :497, :505, :553, :747. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-054 — Alçada pontual: no banco real só existem DOIS autorizadores para as seis operações (admin_geral e gestor do grupo)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas as seis / SEG |
| ANTES | A mecânica da alçada estava pronta, mas só admin_geral e o gestor do grupo tinham alçada nas seis operações. Nada mostrava essa lacuna. |
| Causa | Organograma, nao codigo: nomear gerente por loja e decisao do dono. O que faltava no software era VER essa lacuna. |
| Correção | AuthorizationService.quemLiberaNaOperacao (mesma regua de POST /authorizations, conta ativa, so nome e perfil) e GET /core/authorizations/quem-libera (balcao e escritorio): gerentes da operacao, donos do grupo, semAlcadaNaOperacao e as acoes que dependem de liberacao. Cartao "Quem libera nesta operacao" em Usuarios e equipe diz de quem toda liberacao depende e como resolver (cadastrar Gerente de loja/oficina, caminho que ja existe desde o GAP-PRD-010). |
| DEPOIS | GET /core/authorizations/quem-libera lista quem libera na operação (gerentes dela e donos do grupo; só nome e perfil, sem login) e sinaliza semAlcadaNaOperacao. O cartão QuemLiberaAqui aparece em Usuários e equipe. Cadastrar gerente_loja/gerente_oficina já funciona e, com o GAP-PRD-010 corrigido, não abre escalada. Nenhuma linha de código falta: o que falta é o organograma. |
| Arquivos | server/src/services/core/AuthorizationService.ts, server/src/routes/v1/core.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/alcada.ts, src/components/gs/QuemLiberaAqui.tsx, src/pages/gs/EquipePage.tsx, server/tests/quem-libera-nesta-operacao.test.ts, src/components/gs/__tests__/quemLiberaAqui.test.tsx |
| COMMIT | 4378eab |
| TESTES | server/tests/quem-libera-nesta-operacao.test.ts (7 casos): só donos gera semAlcadaNaOperacao. Gerente de outra operação não conta, gerente desligado não conta, a resposta não traz login, mecânico e contador recebem 403. src/components/gs/__tests__/quemLiberaAqui.test.tsx (3 casos). Rodei: verdes. Não verifiquei o organograma no banco real. |
| EVIDÊNCIA | server/src/services/core/AuthorizationService.ts:155-176 (mesma régua de AUTHORIZERS, conta ativa); server/src/routes/v1/core.ts:5755-5769 (abertaAo balcao/escritorio); src/pages/gs/EquipePage.tsx:191 (<QuemLiberaAqui />); HierarquiaDePerfis.ts:140-148 (gestor/admin podem atribuir gerente). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel decide quem tem alçada em cada loja e cadastra gerente_loja ou gerente_oficina por operação em Usuários e equipe. |

### GAP-PRD-055 — Atrás de proxy reverso sem DEVORA_TRUST_PROXY, as seis operações dividem um balde de 300 req/min e uma falha de refresh (429/5xx) derruba o caixa

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Todas (depende da topologia de publicação) / SEG |
| ANTES | Sem DEVORA_TRUST_PROXY atrás de um proxy, as seis operações dividiam um balde de 300 req/min. Qualquer !res.ok no /auth/refresh (inclusive 429 e 5xx) deslogava o caixa. |
| Causa | O valor e da publicacao (externo); o cliente tratava falha transitoria da renovacao como credencial morta, e o servidor nao percebia proxy nao declarado. |
| Correção | Cliente: so a RECUSA da credencial no refresh (400/401/403) apaga a sessao; 429, 5xx, rede e corpo nao-JSON deixam a sessao onde esta e a tela recebe API_SESSION_REFRESH_UNAVAILABLE dizendo que a pessoa continua conectada; a proxima requisicao renova. Servidor: middleware/observarProxy.ts percebe X-Forwarded-For com o valor em 0 (PROXY_NAO_DECLARADO) e requisicao de fora sem o cabecalho com valor > 0 (PROXY_DECLARADO_MAS_ACESSO_DIRETO; loopback nao conta), avisa uma vez no log (publicacao_proxy_nao_declarado / publicacao_proxy_contornado, com a orientacao) e devolve o estado em /core/system/secrets-readiness, campo publicacao; nao liga trust proxy sozinho. O GAP-PRD-074 fez o bloqueio por par honrar o mesmo valor. DEPLOY.md e POST_DEPLOY_CHECKLIST.md dizem como conferir. |
| DEPOIS | DEVORA_TRUST_PROXY é validada (inteiro de 0 a 10) e liga o trust proxy. O cliente só apaga a sessão com 400/401/403 no refresh. Com 429, 5xx, rede fora ou HTML, a sessão fica e o erro diz que a pessoa segue conectada. O servidor detecta proxy não declarado ou contornado, avisa uma vez no log e publica o estado em /core/system/secrets-readiness (campo publicacao). DEPLOY.md e POST_DEPLOY_CHECKLIST.md explicam o valor. |
| Arquivos | src/lib/api/client.ts, server/src/middleware/observarProxy.ts, server/src/app.ts, server/src/db/secretsReadiness.ts, docs/DEPLOY.md, docs/POST_DEPLOY_CHECKLIST.md, src/lib/api/__tests__/renovacaoDaSessaoNaoDerrubaOCaixa.test.ts, server/tests/proxy-nao-declarado-aparece.test.ts |
| COMMIT | 4cc0eb3, 38323e3 |
| TESTES | src/lib/api/__tests__/renovacaoDaSessaoNaoDerrubaOCaixa.test.ts (8 casos): 429, 502, rede fora e 200 com HTML mantêm a sessão; 401 e 403 apagam. server/tests/proxy-nao-declarado-aparece.test.ts (7 casos): PROXY_NAO_DECLARADO, PROXY_DECLARADO, acesso direto e secrets-readiness sem valor sensível. Rodei: verdes. O stderr mostra ValidationError do express-rate-limit (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR): é só log, não falha. |
| EVIDÊNCIA | server/src/config/env.ts:264; server/src/app.ts:84 (trust proxy), :144 (observarProxy), :277-284 (rateLimit); src/lib/api/client.ts:420-445, :484-497; server/src/middleware/observarProxy.ts:67-124; server/src/db/secretsReadiness.ts:228; docs/DEPLOY.md:180; docs/POST_DEPLOY_CHECKLIST.md:21; .env.production.example:38. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel define DEVORA_TRUST_PROXY no .env da publicação com o número de saltos (1 atrás de nginx/Caddy/túnel; 2 com CDN na frente; 0 direto na LAN), reinicia e confere publicacao.estado em /api/v1/core/system/secrets-readiness. Essa rota não tem tela; o estado também sai no log. |

### GAP-PRD-056 — npm run db:migrate é um no-op no Windows: a guarda de CLI de migrate.ts compara `file://C:/...` com `file:///C:/...%20...`

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | todas (instalação única) / DEP |
| ANTES | No Windows, a guarda de CLI de migrate.ts nunca casava (file:// contra file:///, %20). npm run db:migrate saía em silêncio sem migrar e só cobria a camada de documentos. |
| Causa | Guarda de linha de comando montada a mao (URL com duas barras e sem %20) nunca casava no Windows; e o CLI so chamava runMigrations (camada de documentos, alvo 19), sem migrateCoreSchema. |
| Correção | utils/pontoDeEntrada (compara caminhos: fileURLToPath x argv resolvido, realpath, sem caixa no Windows); db/migracaoCompleta.prepararBanco() usado pelo boot (index.ts) e pelo comando (documentos + nucleo com snapshot + bancadas oficiais); o comando diz antes/depois e sai com 1 se nao ficou EM_DIA; DEPLOY.md documenta o upgrade a frio (node server/dist/db/migrate.js). |
| DEPOIS | A guarda compara caminhos com fileURLToPath, resolve, realpath e sem caixa no Windows. O comando chama prepararBanco (documentos, núcleo, bancadas oficiais), o mesmo do boot. Imprime antes e depois, sai 1 se não ficou EM_DIA e recusa migrar com a API no ar. |
| Arquivos | server/src/utils/pontoDeEntrada.ts, server/src/db/migracaoCompleta.ts, server/src/db/migrate.ts, server/src/index.ts, server/tests/o-db-migrate-migra-de-verdade.test.ts, docs/DEPLOY.md |
| COMMIT | 44faa8b |
| TESTES | server/tests/o-db-migrate-migra-de-verdade.test.ts: processo real via tsx em pasta com espaço; o status passa a EM_DIA; ADIANTADO preservado. Rodei: verde. |
| EVIDÊNCIA | server/src/utils/pontoDeEntrada.ts:21-43; server/src/db/migrate.ts:56-60; server/src/db/migracaoCompleta.ts:27-33 (prepararBanco) e 47-90 (migrarPelaLinhaDeComando); server/src/index.ts:67 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-057 — db:status e /system/readiness medem a versão da camada de documentos (19); o checklist fala em v73 e o alvo real do núcleo é 84

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | todas / DEP |
| ANTES | db:status e /system/readiness mediam a camada de documentos (19) e davam READY por db.version>=15. O checklist citava v73, e o núcleo estava em 84. |
| Causa | Dois relogios (db_meta.version da camada herdada x core_meta.core_schema_version do nucleo) e a sonda medindo o que nao muda mais; checklist citando v73. |
| Correção | db/versaoDoEsquema: nucleo (versao + marcas de passo) contra CORE_TARGET_VERSION, situacao EM_DIA/ATRASADO/ADIANTADO/NUNCA_MIGRADO/SEM_BANCO, leitura do arquivo so com readOnly; status.ts sem escrita e com codigo de saida; readiness, release e staging medem o nucleo (sem loadDb), sem indexedDbVersion inventado; pendencias externas nomeiam a chave de producao desligada; migrateCoreSchema nao rebaixa numero de banco mais novo (rollback); GO_LIVE_CHECKLIST/KNOWN_LIMITATIONS/DEPLOY sem v73; tela Configuracoes > Sistema mostra o mesmo numero. |
| DEPOIS | status.ts abre o banco só para leitura e imprime a situação do núcleo contra CORE_TARGET_VERSION (EM_DIA/ATRASADO/ADIANTADO/NUNCA_MIGRADO/SEM_BANCO), com código de saída. A prontidão só dá READY com o núcleo EM_DIA e databaseVersion vem do núcleo. GO_LIVE_CHECKLIST manda conferir situacao EM_DIA; v73 só aparece como nota histórica em KNOWN_LIMITATIONS. |
| Arquivos | server/src/db/versaoDoEsquema.ts, server/src/db/status.ts, server/src/db/core-migrations.ts, server/src/services/system-admin/CoreProductionReadinessService.ts, server/src/services/system-admin/SystemAdminService.ts, server/src/services/system-admin/StagingReadinessService.ts, server/tests/a-prontidao-mede-o-nucleo.test.ts, server/tests/system-admin.test.ts, server/tests/prompt26-audit-compliance.test.ts, server/tests/prompt29-operational-homologation.test.ts, server/tests/prompt30-final-release.test.ts, docs/GO_LIVE_CHECKLIST.md, docs/KNOWN_LIMITATIONS.md, docs/DEPLOY.md |
| COMMIT | 44faa8b |
| TESTES | server/tests/a-prontidao-mede-o-nucleo.test.ts (a prontidão mede o núcleo) e o-db-migrate-migra-de-verdade.test.ts (status EM_DIA, ADIANTADO). Rodei: verdes. |
| EVIDÊNCIA | server/src/db/status.ts:23-39; server/src/services/system-admin/CoreProductionReadinessService.ts:192-202 (READY exige schema.situacao EM_DIA), 217, 226; docs/GO_LIVE_CHECKLIST.md:61-62; docs/KNOWN_LIMITATIONS.md:14 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-058 — Cópia remota dos uploads tem teto de 200 MB e é montada síncrona em memória no processo da API (hash de todos os arquivos + base64 + gzip), na hora do boot+24h

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | todas / DEP |
| ANTES | A cópia remota das fotos tinha teto de 200 MB e era montada síncrona em memória (hash, base64, gzip). O VACUUM INTO síncrono travava a API no horário do boot +24 h. |
| Causa | pacote unico em memoria, sincrono, na thread da API; sem indice de digitais; agenda relativa ao boot |
| Correção | copia diaria numa worker thread (codigo eval, conexao propria readOnly, WAL incluido); envio das fotos por conteudo (uploads/objetos/<sha256>, sem x-upsert, 409 = ja esta la, manifesto versao 2 por ultimo e so com tudo enviado), indice core_backup_uploads (nao rele arquivo com mesmo tamanho e data), core_backup_objetos_remotos por destino, tudo assincrono e sem teto; DEVORA_BACKUP_HORA (vazio = 03:00 pelo relogio da loja) com a copia ao subir so sem diario de 20 h; pacote versao 1 vira formato de leitura; aviso na tela de estado (GAP-PRD-011). |
| DEPOIS | A cópia diária roda numa worker thread com conexão readOnly. As fotos sobem uma a uma por sha256, com índice que não relê arquivo inalterado, hash por stream, readFile assíncrono e sem teto; o manifesto sobe por último. O horário é fixo (DEVORA_BACKUP_HORA, padrão 03:00). montarPacote (teto de 200 MB) não tem chamador no diário. |
| Arquivos | server/src/db/backup.ts, server/src/db/backupUploads.ts, server/src/db/backupRemoto.ts, server/src/services/backup/uploadsIncrementais.ts, server/src/services/backup/bucket.ts, server/src/services/backup/agendaDoBackup.ts, server/src/services/backup/diarioDoBackup.ts, server/src/config/env.ts, .env.example, .env.staging.example, .env.production.example, server/tests/os-arquivos-tambem-precisam-voltar.test.ts, server/tests/o-diario-nao-para-o-balcao.test.ts, server/tests/helpers/bucketDeMentira.ts |
| COMMIT | d6c2024 |
| TESTES | server/tests/o-diario-nao-para-o-balcao.test.ts: o laço de eventos gira durante a cópia de 60 mil linhas; a cópia traz o -wal; só o que falta sobe; 409 conta como presente; falha num objeto não sobe manifesto; hora 03:00 da loja; paginação. Rodei: verde. |
| EVIDÊNCIA | server/src/db/backup.ts:217-262 (worker eval + snapshotDatabaseEmSegundoPlano), 504-527 (agenda na hora marcada); server/src/services/backup/diarioDoBackup.ts:89 e 148; server/src/services/backup/uploadsIncrementais.ts:115 (createReadStream), 162-176 (índice core_backup_uploads), 247-339 (envio por objeto, manifesto só com tudo enviado); server/src/config/env.ts:184-187; aviso na tela pelo estadoDoBackup.ts:265-321 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-059 — logError({ err }) serializa Error como {}: a falha do diário de backup e do laço de expiração de reserva ficam sem mensagem no log

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | todas / DEP |
| ANTES | sanitizeForLog percorria Object.entries. Um Error virava {} e backup_diario_falhou saía sem causa. |
| Causa | sanitizeForLog percorria Object.entries e message/stack de Error nao sao enumeraveis |
| Correção | sanitizeForLog transforma Error em { name, message, stack de ate 4 quadros, code, campos proprios (code/status de ApiError), cause }, com a mesma mascara de segredo; ciclo vira [circular]. Os dois chamadores (backup_diario_falhou e reserva_expiracao_laco) ficam legiveis sem mudanca. |
| DEPOIS | sanitizeForLog trata instanceof Error: devolve name, message, pilha de até 4 quadros, campos próprios (code/status), cause e ciclo como [circular], tudo com a máscara de segredo. Os chamadores backup.ts:497 e OrderReservationExpiry.ts:118/145 passam { err } sem mudança. |
| Arquivos | server/src/utils/errors.ts, server/tests/o-log-diz-qual-foi-o-erro.test.ts |
| COMMIT | fa9411e |
| TESTES | server/tests/o-log-diz-qual-foi-o-erro.test.ts. Em o-estado-do-backup-aparece.test.ts:163-164 a linha real de backup_diario_falhou contém 'no space left on device'. Rodei: verdes. |
| EVIDÊNCIA | server/src/utils/errors.ts:31-80; server/src/db/backup.ts:497; server/src/services/core/OrderReservationExpiry.ts:118,145 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-060 — docker-compose.staging.yml sobe homologação com segredos publicados no repositório que a régua de produção aceita

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | todas (homologação) / DEP |
| ANTES | docker-compose.staging.yml trazia JWT e chave de cifra literais, e loadEnv os aceitava em staging. |
| Causa | VALORES_PUBLICADOS e o teste da regua olhavam so os .env.*.example; a varredura de segredos nem abria .yml |
| Correção | Os compose pedem DEVORA_JWT_SECRET, DEVORA_ENCRYPTION_KEY e DEVORA_FRONTEND_ORIGIN ao host com ${VAR:?}; staging deixa de carregar .env.staging.example como env_file; os quatro valores publicados pelos compose entram em VALORES_PUBLICADOS; o teste le os compose; secret:scan passa a abrir .yml/Dockerfile e reprova segredo literal no compose (e deixa de contar o marcador [REDACTED] do relatorio como vazamento). |
| DEPOIS | Os dois compose pedem DEVORA_JWT_SECRET, DEVORA_ENCRYPTION_KEY e DEVORA_FRONTEND_ORIGIN ao host com ${VAR:?}. O staging não usa mais env_file de exemplo. Os quatro valores antigos dos compose estão em VALORES_PUBLICADOS: conferi por programa contra dc48841 e 8caa1f3, sem imprimir os valores. chaveFraca os recusa. |
| Arquivos | docker-compose.staging.yml, docker-compose.yml, server/src/config/env.ts, server/src/scripts/varredura-de-segredos.ts, server/tests/producao-recusa-a-chave-de-desenvolvimento.test.ts, server/tests/a-imagem-docker-guarda-o-que-e-dado.test.ts |
| COMMIT | 38e526a |
| TESTES | server/tests/producao-recusa-a-chave-de-desenvolvimento.test.ts:269-310: nenhum compose tem segredo literal aceito; os 4 valores antigos são recusados em staging e em produção. a-imagem-docker-guarda-o-que-e-dado.test.ts:427 (sem segredo no compose). Rodei: verdes. |
| EVIDÊNCIA | docker-compose.staging.yml:24-26; docker-compose.yml:34-36; server/src/config/env.ts:394-405 (VALORES_PUBLICADOS), 432-437 (chaveFraca) |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Operacional, não é código: se alguma homologação já subiu com o compose antigo, rotacionar a chave (scripts/rotacionar-chave) e trocar as credenciais que ela guardou. |

### GAP-PRD-061 — Sem .dockerignore: `COPY . .` leva 3,6 GB de backups, o banco operacional, .env com segredos e node_modules para a camada do builder

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DEPLOYMENT_RISK |
| Empresa / frente | todas / INT |
| ANTES | Não havia .dockerignore. O COPY . . levava backups (3,6 GB), o banco, .env e node_modules para a camada do builder. |
| Causa | contexto de build sem filtro: o COPY . . levava tudo o que esta na pasta, inclusive dado de operacao e segredos |
| Correção | .dockerignore: **/node_modules, out, dist, server/dist, server/data, server/backups, data, **/*.db(-wal/-shm), **/.env e **/.env.*, **/*.pfx/.p12/.pem/.key, .git, .github, .claude, logs e dumps de teste. .gitattributes fixa LF nos arquivos que vao para Linux. |
| DEPOIS | .dockerignore exclui **/node_modules, out, dist, server/data, server/backups, data, *.db/-wal/-shm, **/.env e **/.env.*, chaves e certificados, .git e .claude. O estágio final só copia do builder. |
| Arquivos | .dockerignore, .gitattributes, server/tests/a-imagem-docker-guarda-o-que-e-dado.test.ts, docs/DEPLOY.md, server/src/services/implantacao/frontendEstatico.ts, server/tests/a-api-serve-as-telas-com-fallback.test.ts, src/lib/build/configuracaoDoBuild.ts, vite.config.ts |
| COMMIT | 38e526a, d5b8e61, 5a739b6 |
| TESTES | server/tests/a-imagem-docker-guarda-o-que-e-dado.test.ts:135-197: aplica a semântica do .dockerignore aos caminhos da instalação e à árvore real; nenhum .db, .env, chave ou node_modules entra. Rodei: verde. Não houve docker build real: não há Docker na máquina. |
| EVIDÊNCIA | .dockerignore (linhas de node_modules, server/data, **/*.db, **/.env.*, **/*.pfx); Dockerfile:15 (COPY . . sob o .dockerignore) e estágio final só com COPY --from=builder |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-062 — Em Docker as fotos vão para /app/data/uploads, fora do volume: somem ao recriar o container

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DEPLOYMENT_RISK |
| Empresa / frente | todas / DEP |
| ANTES | Em Docker as fotos iam para /app/data/uploads, fora do volume, e sumiam ao recriar o container. A imagem rodava como root, com HEALTHCHECK em /health. |
| Causa | o caminho historico das fotos (<raiz>/data/uploads) fica fora do unico volume declarado; a imagem nao declarava onde mora cada dado |
| Correção | Imagem: ENV DEVORA_DATABASE_PATH e DEVORA_UPLOADS_DIR em /app/server/data, DEVORA_BACKUP_DIR em /app/backups, VOLUME dos dois, pastas do usuario node, USER node, HEALTHCHECK em /api/v1/readiness (node fetch, 503 reprova), NODE_ENV e DEVORA_API_ENV production. Compose com volumes nomeados (nunca a pasta server/data do host, onde mora o banco da loja), stop_grace_period 15s. A conferencia da implantacao BLOQUEIA banco/fotos fora do volume quando roda em container. |
| DEPOIS | A imagem define DEVORA_UPLOADS_DIR=/app/server/data/uploads e DEVORA_DATABASE_PATH dentro do VOLUME /app/server/data, e o backup em /app/backups (outro VOLUME). Roda com USER node e HEALTHCHECK em /api/v1/readiness. Os compose usam volumes nomeados e declaram o mesmo DEVORA_UPLOADS_DIR. A conferência da implantação BLOQUEIA fotos fora do volume em container. |
| Arquivos | Dockerfile, docker-compose.yml, docker-compose.staging.yml, server/src/services/implantacao/conferenciaDaImplantacao.ts, server/tests/a-imagem-docker-guarda-o-que-e-dado.test.ts |
| COMMIT | 38e526a, fb3874f |
| TESTES | server/tests/a-imagem-docker-guarda-o-que-e-dado.test.ts:262-310 (ENV absolutos dentro de VOLUME, fotos fora de /app/data, sem root, HEALTHCHECK readiness) e 396-435 (cada compose com volumes nomeados); a-conferencia-da-implantacao.test.ts (fotos fora do volume = BLOQUEIA). Rodei: verdes. Não houve container real: não há Docker. |
| EVIDÊNCIA | Dockerfile (ENV DEVORA_UPLOADS_DIR/DEVORA_DATABASE_PATH/DEVORA_BACKUP_DIR, VOLUME [/app/server/data, /app/backups], USER node, HEALTHCHECK /api/v1/readiness); docker-compose.yml (DEVORA_UPLOADS_DIR + devora-dados:/app/server/data); docker-compose.staging.yml (idem com staging-dados); server/src/services/implantacao/conferenciaDaImplantacao.ts:345-352 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-063 — Sem tratador de unhandledRejection/uncaughtException e sem supervisor: um erro assíncrono fora de try/catch derruba a API das seis empresas

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DEPLOYMENT_RISK |
| Empresa / frente | todas / DEP |
| ANTES | Sem tratador de unhandledRejection/uncaughtException. O desligamento era server.close sem prazo e sem closeConnection, e podia pendurar em keep-alive. |
| Causa | o processo nao tinha rede de seguranca nem desligamento com prazo |
| Correção | services/implantacao/cicloDoProcesso.ts: criarDesligamento (para trabalhadores, fecha servidor, derruba ociosas, corta presas no prazo de 8 s, fecha o SQLite, sai; segundo pedido forca; codigo maior vence) e instalarRedeDeSeguranca (rejeicao nao tratada = log com causa e pilha e segue; excecao nao tratada = log e desliga com 1; SIGINT/SIGTERM/SIGBREAK e IPC do supervisor = desliga; IPC fechado = desliga). index.ts monta os dois antes de abrir a porta. |
| DEPOIS | A rejeição não tratada vira log e o processo segue. A exceção não tratada vira log e desliga com 1. SIGINT/SIGTERM/SIGBREAK, o IPC do supervisor e o disconnect desligam com prazo de 8 s, derrubam conexões ociosas e presas, soltam a trava e fecham o SQLite. Existe um supervisor (npm run api:supervisionar). |
| Arquivos | server/src/services/implantacao/cicloDoProcesso.ts, server/src/index.ts, server/tests/o-processo-registra-o-erro-e-desliga-com-prazo.test.ts, server/tests/o-boot-liga-o-que-promete.test.ts |
| COMMIT | ca56810, fb3874f |
| TESTES | server/tests/o-processo-registra-o-erro-e-desliga-com-prazo.test.ts: afirma que a rejeição é logada com a causa e o processo segue; que a exceção desliga com 1; que um servidor HTTP real com requisição pendurada desliga dentro do prazo; que o banco fecha mesmo com falha; que o segundo pedido força a saída. Rodei: verde. a-api-tem-quem-a-levante.test.ts existe (supervisor com backoff e e2e). Não rodei esse, porque sobe a API real. |
| EVIDÊNCIA | server/src/services/implantacao/cicloDoProcesso.ts:87-151 (criarDesligamento: prazo, closeAllConnections, closeIdleConnections, fecharBanco) e :165-210 (instalarRedeDeSeguranca); server/src/index.ts:102-112 (monta antes de server.listen, e fecharBanco chama closeConnection); package.json:80 api:supervisionar; server/src/scripts/supervisionar-api.ts e parar-api.ts existem. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-064 — Docs citam telas e comandos que não existem: /sistema/administracao/status|saude|prontidao|go-live, Administração → Recovery/Reconciliação/Erros, npm run restore:verify, npm run seed; e todo o roteador /system/* não tem tela (inventory cravado)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | todas / DEP |
| ANTES | Os docs citavam /sistema/administracao/*, npm run restore:verify e npm run seed, que não existem. O /system/* tinha rotas cravadas (inventory CP01-CP73) sem tela, e o requestId do erro era descartado pelo cliente. |
| Causa | Documentacao e roteador /system escritos para telas planejadas que nunca nasceram; o envelope de erro tinha requestId e o cliente o jogava fora. |
| Correção | Sairam /health-dashboard, /recovery, /reconciliation, /homologations, /inventory, /go-live e /go-live/activate-core (e servicos e OpenAPI); /system/release traz o processo; tela Configuracoes > Sistema (versao e banco nucleo x alvo, prontidao, cofre via /core/system/secrets-readiness que nao tinha tela, ultimos erros da aba com requestId); ApiRequestError.requestId, 5xx com "Codigo para o suporte", 20 ultimos erros em memoria; os quatro roteiros reescritos para telas e comandos reais e .env.production.example com o seed certo; teste que confere cada /sistema/..., npm run e node server/dist/... citado em seis roteiros. |
| DEPOIS | O system-admin só tem rotas reais (health, readiness, implantacao, release, backup), todas com tela. As rotas cravadas e o /audit saíram do código e do OpenAPI. Os docs não citam mais caminhos inexistentes. O ApiRequestError guarda o requestId, o 5xx mostra 'Código para o suporte' e a tela Sistema lista os últimos erros com o requestId. |
| Arquivos | server/src/routes/v1/system-admin.ts, server/src/services/system-admin/SystemAdminService.ts, server/src/openapi/spec.ts, src/lib/api/client.ts, src/lib/api/sistema.ts, src/pages/gs/SistemaPage.tsx, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, docs/OPERATIONS.md, docs/POST_DEPLOY_CHECKLIST.md, docs/GO_LIVE_ROLLBACK.md, docs/MONITORING_FIRST_HOURS.md, .env.production.example, server/tests/o-roteador-do-sistema-so-tem-o-que-e-verdade.test.ts, server/tests/os-documentos-apontam-para-o-que-existe.test.ts, server/tests/o-menu-nao-promete-o-que-o-servidor-nega.test.ts, src/pages/gs/__tests__/SistemaPage.test.tsx, src/lib/__tests__/erro-traz-o-codigo-do-log.test.ts, src/router/__tests__/environments.test.tsx |
| COMMIT | 99f51e7, 44faa8b |
| TESTES | server/tests/os-documentos-apontam-para-o-que-existe.test.ts: referenciasQuebradas(doc) == [] para cada roteiro, e a régua pega o texto antigo. server/tests/o-roteador-do-sistema-so-tem-o-que-e-verdade.test.ts. Tela: SistemaPage.test.tsx e erro-traz-o-codigo-do-log.test.ts. Rodei todos: verdes. |
| EVIDÊNCIA | server/src/routes/v1/system-admin.ts:26-235 (rotas vivas; o comentário em :148-173 registra o que saiu); server/src/openapi/spec.ts:132-138 (só os /system reais); src/lib/api/client.ts:72,665-680 (requestId); src/pages/gs/SistemaPage.tsx:327-341; src/router/gsRoutes.tsx:342 (/sistema/configuracoes/sistema). A busca por sistema/administracao, restore:verify e 'npm run seed' em docs/*.md e .env.production.example não achou nada. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-065 — Editar o .env só vale no próximo boot (loadEnv cacheado) e as telas de E-mails e Sincronização listam o que falta sem dizer 'reinicie a API'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | todas / EML |
| ANTES | EMAIL_* era lido por loadEnv com cache. Editar o .env só valia depois de reiniciar, e as telas não diziam isso. |
| Causa | Leitura única no boot para credenciais que o dono cola com o servidor no ar, e telas que mandam preencher sem dizer o que acontece depois. |
| Correção | env.ts: lerVariaveisAoVivo(chaves) relê os .env a cada chamada com a precedência do boot (variável do ambiente do sistema manda; a do arquivo é relida) e sem reescrever process.env (getConnection relê DEVORA_DATABASE_PATH a cada chamada, e um refresh global trocaria de banco); o carregador passa a guardar o que o arquivo injetou. EmailService lê EMAIL_* ao vivo (status, flush, transporte montado a cada flush, máscara da senha no motivo) e acusa porta inválida no que falta. SyncService (mínimo, domínio DEP): supabaseConfig e o missing do syncStatus leem ao vivo. As telas de E-mails e de Sincronização dizem que o servidor relê o .env e não precisa reiniciar, com a exceção do ambiente do sistema. DEPLOY.md atualizado. |
| DEPOIS | EMAIL_* e DEVORA_SUPABASE_* são relidos do .env a cada pergunta, com a precedência do boot e sem reescrever process.env. O carteiro sobe sempre no boot. As telas de E-mails e Sincronização dizem que não precisa reiniciar, salvo variável definida no ambiente do sistema. |
| Arquivos | server/src/config/env.ts, server/src/services/notifications/EmailService.ts, server/src/services/sync/SyncService.ts, server/tests/smtp-sem-reinicio.test.ts, server/tests/carteiro-nao-decide-no-boot.test.ts, src/pages/gs/EmailsPage.tsx, src/pages/gs/SincronizacaoPage.tsx, src/pages/gs/__tests__/EmailsPage.test.tsx, src/pages/gs/__tests__/SincronizacaoPage.test.tsx, docs/DEPLOY.md |
| COMMIT | 6d929ce, 95d1de1 |
| TESTES | server/tests/smtp-sem-reinicio.test.ts (7 casos): .env real em pasta temporária. Preencher com o servidor no ar muda o status e a fila sai. Trocar a senha troca a do transporte. Apagar a linha desliga. Porta inválida é acusada. O ambiente do sistema manda. process.env não é reescrito. A central sai de READY_FOR_CREDENTIAL. EmailsPage.test e SincronizacaoPage.test: 'não precisa reiniciar'. Rodei: verdes. |
| EVIDÊNCIA | server/src/config/env.ts:113-136 (lerVariaveisAoVivo); server/src/services/notifications/EmailService.ts:220-245 (configSmtp ao vivo), :1524-1539 (transporte montado a cada flush); server/src/services/sync/SyncService.ts:124-135; server/src/index.ts:176-196 (startEmailFlushWorker sem condição); src/pages/gs/EmailsPage.tsx:223-227; src/pages/gs/SincronizacaoPage.tsx:215-218. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-066 — SVG com <script> é aceito como logo/capa da loja e servido em /uploads/lojas como image/svg+xml sem CSP/sandbox

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | todas / DEP |
| ANTES | Um SVG com <script> era aceito como logo ou capa e servido em /uploads/lojas como image/svg+xml, sem CSP. Aberto pela URL direta, executava na origem do ERP. |
| Causa | ACEITOS incluía image/svg+xml, o tipo vinha só do rótulo do cliente, e os express.static das pastas públicas ficam antes do middleware de cabeçalhos de segurança. |
| Correção | StorefrontSettingsService: SVG fora dos aceitos; a assinatura dos bytes (PNG/JPEG/WebP) tem de bater com o tipo declarado (CORE_IMAGE_CONTENT_MISMATCH). app.ts: as três pastas públicas saem com 'Content-Security-Policy: sandbox; default-src none' e nosniff — o SVG antigo no disco abre sem rodar nada, e <img> não é afetado. LojaAdminPage: o seletor só oferece PNG, JPEG e WebP. |
| DEPOIS | O SVG saiu dos aceitos. Os bytes precisam bater com a assinatura PNG/JPEG/WebP (CORE_IMAGE_CONTENT_MISMATCH). /uploads/produtos, /lojas e /equipamentos saem com 'Content-Security-Policy: sandbox; default-src none' e nosniff. /uploads/os só abre por link assinado, com o cabeçalhosDeSeguranca global na frente. A tela só oferece PNG, JPEG e WebP. |
| Arquivos | server/src/services/core/StorefrontSettingsService.ts, server/src/app.ts, src/pages/gs/LojaAdminPage.tsx, server/tests/imagem-da-loja-sem-conteudo-ativo.test.ts, src/pages/gs/__tests__/LojaAdminImagemSemSvg.test.tsx |
| COMMIT | a0392d2 |
| TESTES | server/tests/imagem-da-loja-sem-conteudo-ativo.test.ts: SVG recusado com 400 CORE_IMAGE_FORMAT_INVALID; SVG disfarçado de PNG recusado com CORE_IMAGE_CONTENT_MISMATCH; PNG real aceito; CSP com sandbox e default-src 'none' e nosniff; /uploads/os responde 403 sem assinatura. src/pages/gs/__tests__/LojaAdminImagemSemSvg.test.tsx: o accept não contém svg. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/StorefrontSettingsService.ts:268-272 (ACEITOS sem svg), :281-296 (tipoPelosBytes), :335-369 (recusas); server/src/app.ts:89 (cabecalhosDeSeguranca global), :216-242 e :264-273 (semConteudoAtivo); src/pages/gs/LojaAdminPage.tsx:346 accept=image/png,image/jpeg,image/webp. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-067 — Não existe checklist de implantação por empresa: prontidão está espalhada em ~8 superfícies por domínio, sem visão PRONTO/PENDENTE/N.A./BLOQUEADO por tenant

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | todas (6 tenants) / DEP |
| ANTES | Não havia checklist de implantação por empresa. A prontidão ficava espalhada em cerca de 8 telas de domínio, sem estado por tenant. |
| Causa | Cada dominio respondia so pelo seu pedaco; nao havia consolidacao por tenant nem lugar para gravar confirmacao e "nao se aplica". |
| Correção | services/implantacao/implantacaoPorEmpresa: 24 itens em 10 areas chamando as funcoes de cada dominio (sem rede), estados PRONTO/AUTO_DETECTADO/CONFIRMADO/PENDENTE/DIVERGENTE/NAO_APLICAVEL/BLOQUEADO_EXTERNAMENTE com dono e tela; core_implantacao_marcas (DDL canonica) com assinatura dos valores confirmados (mudou -> DIVERGENTE) e motivo obrigatorio para N.A.; rotas GET /system/implantacao/empresas, GET/PUT/DELETE /system/implantacao/empresas/:id[/itens/:item/marca] com system-readiness.view/manage + vinculo de gestao na empresa, auditadas; tela Empresas do grupo > Implantacao e coluna de situacao na lista. |
| DEPOIS | O serviço implantacaoPorEmpresa agrega os domínios com os estados PRONTO, AUTO_DETECTADO, CONFIRMADO, PENDENTE, DIVERGENTE, NAO_APLICAVEL e BLOQUEADO_EXTERNAMENTE. Tem rotas GET, PUT e DELETE guardadas por system-readiness.view/manage mais vínculo de gestão na empresa pedida (403 API_TENANT_MISMATCH). Marcar e desmarcar vai para a auditoria. Tem tela Empresas do grupo > Implantação e coluna na lista. |
| Arquivos | server/src/services/implantacao/implantacaoPorEmpresa.ts, server/src/db/schema.ts, server/src/routes/v1/system-admin.ts, server/tests/a-implantacao-de-cada-empresa.test.ts, src/lib/api/implantacaoDasEmpresas.ts, src/pages/gs/ImplantacaoDaEmpresaPage.tsx, src/pages/gs/implantacaoRotulos.ts, src/pages/gs/EmpresasPage.tsx, src/pages/gs/__tests__/ImplantacaoDaEmpresaPage.test.tsx, src/pages/gs/__tests__/EmpresasPage.test.tsx, src/router/gsRoutes.tsx |
| COMMIT | 8741861 |
| TESTES | server/tests/a-implantacao-de-cada-empresa.test.ts: estados, confirmação e divergência por assinatura, N.A. com motivo, vínculo, perfil e auditoria. Tela: ImplantacaoDaEmpresaPage.test.tsx e EmpresasPage.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/implantacao/implantacaoPorEmpresa.ts:17-33 e :64-70 (estados); server/src/routes/v1/system-admin.ts:71-146 (empresaDeGestao, as rotas e recordAudit); src/lib/api/implantacaoDasEmpresas.ts:63-88; src/router/gsRoutes.tsx:685-686; src/pages/gs/EmpresasPage.tsx:335-340. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-068 — Backup local no mesmo disco do banco: DEVORA_BACKUP_DIR não está definido nesta instalação (padrão server/data/backups)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | todas / DEP |
| ANTES | DEVORA_BACKUP_DIR não estava definido na instalação. O backup ficava em server/data/backups, no mesmo disco do banco, e o aviso só aparecia no log. |
| Causa | insumo do dono ausente (outro disco); aviso invisivel |
| Correção | tela Configuracoes > Backup mostra "Backup em outro disco" PENDENTE com a pasta e DEVORA_BACKUP_DIR como saida; mesmo disco pelo dev do volume (ancestral existente; raiz como reserva), usado tambem por LOCAL_BACKUP_SEPARATE_MEDIA; conferencia da implantacao: destino na mesma letra do banco = ATENCAO em producao; GO_LIVE_CHECKLIST cobra outro disco. |
| DEPOIS | O código lê DEVORA_BACKUP_DIR sem nada novo. A comparação de mesmo disco é pelo dev do volume, com a raiz como reserva. A tela Configurações > Backup mostra 'Backup em outro disco' PENDENTE com a pasta e a saída (DEVORA_BACKUP_DIR=...), e PRONTO quando o volume difere. A conferência da implantação dá ATENCAO para a mesma letra em produção. Não verifiquei o .env da loja: é proibido abri-lo. |
| Arquivos | server/src/db/backup.ts, server/src/db/secretsReadiness.ts, server/src/services/implantacao/conferenciaDaImplantacao.ts, server/src/services/backup/estadoDoBackup.ts, src/pages/gs/BackupPage.tsx, docs/GO_LIVE_CHECKLIST.md |
| COMMIT | d6c2024, 9842245 |
| TESTES | server/tests/o-estado-do-backup-aparece.test.ts: mesmo disco dá PENDENTE; outro volume dá PRONTO sem código novo. Rodei: verde. BackupPage.test.tsx (tela): rodei, verde. a-conferencia-da-implantacao.test.ts existe; não rodei. |
| EVIDÊNCIA | server/src/config/env.ts:178 (DEVORA_BACKUP_DIR); server/src/db/backup.ts:56-62 (backupDirectory usa a variável), :86-108 (dispositivoDe, mesmoDisco, backupNoMesmoDiscoDoBanco); server/src/services/backup/estadoDoBackup.ts:186-205 e :366-395; server/src/routes/v1/system-admin.ts:206-208; server/src/services/implantacao/conferenciaDaImplantacao.ts:383-396; .env.production.example:191; docs/GO_LIVE_CHECKLIST.md:42. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel escreve DEVORA_BACKUP_DIR=<pasta em outro disco, pen drive ou volume> no .env da instalação e reinicia a API. Depois confere em Configurações > Backup que 'Backup em outro disco' ficou PRONTO. Nenhuma linha de código falta. |

### GAP-PRD-069 — api_sessions nunca é podada e cada refresh/logout varre a coleção inteira em JavaScript (síncrono, no processo do PDV)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | Todas as seis (coleção única, sem company_id no filtro) / SEG |
| ANTES | refreshSession e revokeSession liam a coleção api_sessions inteira em JavaScript, e nada apagava linhas. Com 40 mil linhas, cada refresh parava o event loop por 300-400 ms. |
| Causa | A camada generica de documentos so oferece varredura, e api_sessions nao tinha poda: cada login e cada renovacao horaria inseriam uma linha para sempre. |
| Correção | services/api/SessoesDeApi.ts: leitura (SELECT data ... WHERE id = ?) e revogacao (json_set sobre a propria linha) pelo indice ix_api_sessions_id que ja existia; sessao sem expiresAt vence em createdAt + 7 dias. Poda amortizada dentro de issueSession (unico escritor): primeira emissao do processo e depois a cada 50, em SQL (json_extract), apagando sessoes vencidas e revogadas e tentativas de login com mais de 24 h; falha da poda so registra, nunca derruba login. Depois: refresh 10-36 ms e logout 12 ms com as mesmas 40 mil linhas (supertest incluso). |
| DEPOIS | Leitura e revogação são feitas por SQL pelo id (índice ix_api_sessions_id). A poda roda em issueSession, na primeira emissão e depois a cada 50, e apaga por json_extract as sessões vencidas e revogadas e as tentativas de login com mais de 24 h. Falha da poda só vai para o log. |
| Arquivos | server/src/services/api/SessoesDeApi.ts, server/src/services/api/ApiAuthService.ts, server/tests/sessoes-de-api-por-id-e-podadas.test.ts, docs/audits/remediacao/migracoes/SEG.md |
| COMMIT | 8d71f1f |
| TESTES | server/tests/sessoes-de-api-por-id-e-podadas.test.ts (9 casos). Uma linha corrompida em outra sessão não derruba o refresh, o que prova que não há varredura. A rotação continua funcionando. Sessão sem expiresAt vence pela criação. A poda apaga vencidas e revogadas, mantém as vivas, roda amortizada e leva tentativas velhas. Rodei: verdes. Não refiz a medição de tempo. |
| EVIDÊNCIA | server/src/services/api/SessoesDeApi.ts:69-81 (SELECT ... WHERE id = ?), :101-112 (json_set pelo id), :125-164 (DELETE de sessões e core_login_attempts), :166-184 (amortizada); server/src/services/api/ApiAuthService.ts:70, :134, :151, :182, :201. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-070 — Produtos e Clientes cortam em 100 sem total nem aviso; os wrappers da tela não pedem página — o seletor de cliente do PDV e as listas de Fidelidade/Locação/Orçamentos/Consignações param em 100

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas; mais crítico em Preço Justo, Gringa, Me Mimei (catálogos e carteiras grandes) / EST |
| ANTES | /products e /customers cortavam em 100 e devolviam só {items}, e o limit de produtos não tinha teto. As telas e os seletores de cliente paravam em 100 sem avisar. |
| Causa | as listas cortavam em LIMIT fixo no servico e a rota devolvia so {items}; os wrappers da tela nao pediam pagina nem liam total; os seletores de cliente/produto carregavam a lista sem termo |
| Correção | servidor: services/core/paginacao.ts (lerPagina/limitarPagina/limitarDeslocamento, teto 500, padrao de cada lista mantido); count* com o MESMO filtro da lista (countProducts, countCustomers, countEquipment + totalPorOrigem, countQuotes, countOrders, countMovements sem JOIN quando nao ha busca); /products, /customers (com e sem termo), /sales, /equipment, /quotes, /orders e /stock/movements devolvem {items,total,limit,offset}; desempate por id na ordem (produto, cliente, orcamento). tela: src/lib/api/paginas.ts (wrappers paginados, tolerantes a servidor sem total), components/gs/Paginacao.tsx (rodape 'Mostrando X-Y de N' + Anterior/Proxima), components/gs/BuscaDeCadastro.tsx (BuscaDeCliente/BuscaDeProduto com busca incremental e 'mostrando 20 de N'); Produtos, Clientes, Vendas (venda do link fora da pagina pedida por id), Orcamentos, Pedidos online, Equipamentos (cartoes pelo total do banco) e Historico de estoque ('Pagina 1 de 3 - 120 movimentos') paginados; seletores por busca em Fidelidade, Locacao (cliente e item), Consignacoes, Orcamentos (cliente do documento pelo id) e Equipamentos; F2 do PDV declara o corte; PdvPage traz o cliente da pre-venda por GET /customers/:id |
| DEPOIS | As listas devolvem {items,total,limit,offset}, com teto de 500 e total que respeita os filtros e a empresa do token. As telas mostram 'Mostrando X–Y de N' e os seletores buscam cliente/produto de forma incremental. |
| Arquivos | server/src/services/core/paginacao.ts, server/src/services/core/CatalogService.ts, server/src/services/core/EquipmentService.ts, server/src/services/core/QuoteService.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/InventoryService.ts, server/src/routes/v1/core.ts, server/tests/paginacao-das-listas.test.ts, src/lib/api/paginas.ts, src/components/gs/Paginacao.tsx, src/components/gs/BuscaDeCadastro.tsx, src/components/gs/ClientePdvDialog.tsx, src/pages/gs/OperacaoPages.tsx, src/pages/gs/PdvPage.tsx, src/pages/gs/FidelidadePage.tsx, src/pages/gs/LocacaoPage.tsx, src/pages/gs/ConsignacoesPage.tsx, src/pages/gs/OrcamentosPage.tsx, src/pages/gs/EquipamentosPage.tsx, src/pages/gs/GestaoPages.tsx, src/pages/gs/MovimentacoesEstoquePage.tsx, src/pages/gs/__tests__/listasDizemQueCortaram.test.tsx, src/pages/gs/__tests__/consignadoNaTela.test.tsx, src/pages/gs/__tests__/prevendaGastaOVale.test.tsx, src/pages/gs/__tests__/pdvTabelaDePreco.test.tsx |
| COMMIT | c31c36c, bd12f7f |
| TESTES | server/tests/paginacao-das-listas.test.ts:128-440 (teto 500, total com busca e filtro, total por empresa, segunda página sem repetir, clientes com termo, equipamentos/orçamentos/pedidos/histórico). src/pages/gs/__tests__/listasDizemQueCortaram.test.tsx:394-620 (rodapés, F2 do PDV, Fidelidade/Locação sem lista completa). Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/paginacao.ts (TETO_DA_PAGINA=500, lerPagina); server/src/routes/v1/core.ts:1086-1092 (products), :3638-3692 (customers com e sem termo), :6020-6023 (sales), :10252-10262 (equipment), :4957-4960 (quotes), :13003-13008 (orders), :3055-3058 (movements); src/pages/gs/OperacaoPages.tsx:354,1127,2187 (Paginacao); BuscaDeCliente em FidelidadePage.tsx:227, LocacaoPage.tsx:187/202, ConsignacoesPage.tsx:553, OrcamentosPage.tsx:1222, EquipamentosPage.tsx:610; src/components/gs/ClientePdvDialog.tsx:37,283 (F2 declara o corte); src/pages/gs/PdvPage.tsx:2058 (cliente da pré-venda por id) |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-071 — Vitrine pública decora o catálogo inteiro a cada requisição, sem teto de limit — 300 req/min por IP bastam para congelar o balcão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | Todas que publicam produtos; o efeito é no processo único (todos os PDVs) / ECO |
| ANTES | A vitrine pública decorava o catálogo inteiro a cada requisição e aceitava qualquer limit (limit=100000 devolvia tudo). |
| Causa | Rota e serviço sem teto de limit, e o custo por requisição proporcional ao catálogo: SELECT de todos os publicados, precarga e decorate de todos, slice só no fim — numa rota pública, no mesmo processo síncrono (node:sqlite) que atende o PDV. |
| Correção | TETO_DA_PAGINA=60 no serviço (vale para /products, /ofertas, /destaques e relacionados; limit inválido ou negativo cai no padrão; offset inválido vira 0); total inalterado. VitrineCache: catálogo decorado por loja (chave vitrine:<slug ou *>, até 32 chaves, WeakMap por conexão) refeito quando total_changes() da conexão mudou (qualquer gravação, sem escritor para esquecer), quando schema_version mudou (DDL) ou quando o minuto virou (promoção com horário). Departamento, galho, destaque e produto excluído viraram filtros em memória sobre o catálogo guardado, com a dobra chave() (só ASCII, igual ao LOWER do SQLite e à árvore de departamentos); busca sobre o texto já dobrado; a página devolvida é cópia rasa. |
| DEPOIS | O teto de página é 60 no serviço (limit inválido ou negativo cai no padrão), valendo para produtos, ofertas, destaques e relacionados. O catálogo decorado fica guardado por loja e é refeito quando total_changes() da conexão muda, quando o esquema muda ou quando o minuto vira. |
| Arquivos | server/src/services/core/VitrineCache.ts, server/src/services/core/StorefrontService.ts, server/tests/vitrine-com-teto.test.ts |
| COMMIT | 259d848 |
| TESTES | server/tests/vitrine-com-teto.test.ts: limit gigante dá no máximo 60 com total verdadeiro, limit não numérico, ofertas com teto, serviço com teto, segunda visita custa só a conferência, venda e promoção nova aparecem na visita seguinte, virada do minuto refaz, página devolvida não altera o guardado. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/StorefrontService.ts:568-573 (TETO_DA_PAGINA=60, tamanhoDaPagina), 605-638 (catalogoDecorado via lembrarDaVitrine) e 747 (limit = tamanhoDaPagina); VitrineCache.ts (versaoDoBanco = total_changes\|schema_version\|minuto; até 32 chaves). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-072 — Dez rotas legadas montadas respondem 200 inventando estado: retry_pending para id inexistente, outbox 'aceito' sem gravar, cursor nulo fixo, homologação com id fabricado, recibo de maquininha fabricado, reconciliação sempre vazia

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas (alcance: admin_geral/gestor e integradores) / DEP |
| ANTES | Rotas legadas respondiam 200 inventando estado: /sync/outbox aceito sem gravar, /sync/cursor null, retry NFC-e/NF-e retry_pending para id inexistente, reconciliação vazia cravada, homologação e ativação do Asaas fingidas, recibo e reimpressão de maquininha fabricados. |
| Causa | Stubs de rotas legadas sem consumidor que respondiam sucesso sem efeito, publicados no OpenAPI. |
| Correção | As onze rotas saíram de routes/v1/{index,nfce,nfe,fiscal,payment-terminals}.ts e do openapi/spec.ts, cada uma com nota do porquê e de onde mora o de verdade (/core/sync/*, /core/fiscal/*, /core/integrations/asaas/homologar, /core/asaas/conciliacao). Quem chama recebe o 404 com envelope (API_NOT_FOUND). api.test ajustado (a ativação de produção fingida vira 404). |
| DEPOIS | /sync/*, /fiscal, /fiscal/nfe e /fiscal/nfce não estão mais montados e respondem 404 com envelope. As rotas /asaas que fingiam respondem 410 API_ROUTE_GONE e apontam a substituta. O retry do Asaas é por empresa (404 e auditoria). O recibo e a reimpressão da maquininha leem o comprovante real por empresa, com 404 para id alheio ou inexistente. Nada disso está no OpenAPI. |
| Arquivos | server/src/routes/v1/index.ts, server/src/routes/v1/nfce.ts, server/src/routes/v1/nfe.ts, server/src/routes/v1/fiscal.ts, server/src/routes/v1/payment-terminals.ts, server/src/openapi/spec.ts, server/tests/o-legado-nao-inventa-estado.test.ts, server/tests/api.test.ts |
| COMMIT | a371bd0 |
| TESTES | server/tests/o-legado-nao-inventa-estado.test.ts: cada rota que fingia não responde 2xx e não grava; o openapi não as descreve; a fila da central responde pelo núcleo; transação de maquininha inexistente dá 404. Rodei: verde. |
| EVIDÊNCIA | server/src/routes/v1/index.ts:88-106 (só /logistics, /payment-terminals e /system fora do núcleo), :228-235 (saiuDoContrato 410), :275-315 e :405-431 (rotas fingidas agora 410), :331-368 (retry por empresa), :370-377 (/sync saiu); server/src/routes/v1/payment-terminals.ts:521-553 (recibo real por companyId); server/src/routes/v1/ não tem mais nfce.ts, nfe.ts nem fiscal.ts. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-073 — LGPD: /core/customers devolve SELECT * (CPF, e-mail, telefone, endereço, notas e portal_invite_hash) a mecânico, estoquista e caixa; não existe exclusão, anonimização nem exportação do titular

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas as seis / SEG |
| ANTES | /core/customers devolvia SELECT * (CPF, e-mail, telefone, endereço, notas e portal_invite_hash) a mecânico, estoquista e caixa. Não havia exportação nem anonimização do titular. |
| Causa | A leitura de cliente e aberta aos tres ambientes por necessidade de tela (PDV vincula cliente, bancada acha o dono do aparelho), mas entregava a linha inteira do banco a todos; o convite do portal, que e credencial, vinha junto no SELECT *; direitos do titular e retencao nunca foram modelados. |
| Correção | services/lgpd/TitularService: projetarCliente por perfil (lista de quem VE o contato: caixas, atendente, gerencia, dono; bancada/estoque recebem nome e ultimos 4 digitos de telefone/documento, sem e-mail/endereco/observacoes, dados_mascarados=true; a busca segue comparando o valor inteiro); exportarDadosDoTitular (14 tabelas por empresa, conta do portal sem senha, trilha, sem coluna com cara de credencial, politica de retencao junto); pendenciasDoTitular (vale, titulo a receber, OS fora de finalizada, locacao, consignacao, pedido online em andamento, chamado aberto); anonimizarTitular em transacao (motivo 10-500 caracteres; linha fica; contato sai do cadastro, dos leads ligados, do customer_name das OS, do vinculo com a conta do portal e das copias em core_outbox; emite customer.upserted anonimizado). CatalogService.getCustomer/listCustomers tiram portal_invite_* na fonte (semSegredoDoConvite). Rotas GET /core/customers/:id/dados-do-titular, POST /core/customers/:id/anonimizar e GET /core/lgpd/retencao (gerente_loja/gerente_oficina + dono), com trilha customer.lgpd_export (so contagens) e customer.lgpd_anonymize (motivo e alcance). services/lgpd/PoliticaDeRetencao declara o que se guarda e por quanto tempo, com os prazos lidos das constantes das podas; services/audit/RetencaoDaAuditoria poda core_audit_log com 5 anos, no maximo 1x/dia, na poda das sessoes. Esquema: core_customers.anonymized_at TEXT anulavel na DDL canonica (sem passo numerado). Tela: DireitosDoTitular na ficha de Clientes (gerencia): exportar baixa o documento do servidor, anonimizar pede motivo + confirmacao e lista as pendencias da recusa, politica de retencao sob demanda; a lista explica a linha mascarada. |
| DEPOIS | Lista e ficha passam por projetarCliente. Bancada e estoque recebem nome e os últimos 4 dígitos, sem e-mail, endereço ou notas (dados_mascarados=true). portal_invite_* sai na fonte para todos. Há rotas para exportar dados do titular, anonimizar (com motivo e pendências) e ler a retenção, só para gerência e donos, com trilha customer.lgpd_export/lgpd_anonymize. Tela DireitosDoTitular na ficha. core_audit_log é podado aos 5 anos e core_login_attempts às 24 h. |
| Arquivos | server/src/services/lgpd/TitularService.ts, server/src/services/lgpd/PoliticaDeRetencao.ts, server/src/services/audit/RetencaoDaAuditoria.ts, server/src/services/core/CatalogService.ts, server/src/services/api/SessoesDeApi.ts, server/src/services/api/ApiIdempotencyService.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, server/tests/lgpd-dados-do-titular.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/lgpd.ts, src/lib/api/core.ts, src/components/gs/DireitosDoTitular.tsx, src/pages/gs/OperacaoPages.tsx, src/pages/gs/__tests__/clientesLgpd.test.tsx, docs/audits/remediacao/migracoes/SEG.md |
| COMMIT | d8d9b24, 4f7e0f1 |
| TESTES | server/tests/lgpd-dados-do-titular.test.ts (17 casos). O mecânico e o estoquista recebem dados mascarados na lista e na ficha. A busca da bancada acha pelo telefone inteiro. O caixa e o atendente veem o contato. O hash do convite não sai para ninguém. Só a gerência exporta e anonimiza, e só na própria operação. Pendências recusam a anonimização. O histórico é mantido. A trilha é podada aos 5 anos. src/pages/gs/__tests__/clientesLgpd.test.tsx (7 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/lgpd/TitularService.ts:66-120 (projeção por perfil), :209, :287, :398; server/src/services/core/CatalogService.ts:1865-1901 (semSegredoDoConvite em getCustomer/listCustomers); server/src/routes/v1/core.ts:3629, :3641, :3689, :3727 (projeção aplicada), :3851-3903 (exportar/anonimizar/retenção com requireProfile gerente e recordAudit); src/pages/gs/OperacaoPages.tsx:974, :1030. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Recomendado, não bloqueia: jurídico ou contador confirmar os textos de base legal e os prazos da política de retenção. Quando um titular com cadastro no Asaas pedir exclusão, apagar também no painel do Asaas. Resíduo declarado fora da ficha: a cópia remota erp_service_orders.customer_name não é reescrita, e as listagens de OS e vendas com nome e telefone não foram revistas por perfil. |

### GAP-PRD-074 — Atrás de proxy reverso o bloqueio por par (login+origem) volta a ser arma: a origem vem do socket, e o socket é o proxy para todo mundo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DEPLOYMENT_RISK |
| Empresa / frente | Todas, quando publicadas atrás de nginx/Caddy/túnel / SEG |
| ANTES | O bloqueio por par (login+origem) lia sempre req.socket.remoteAddress. Atrás de um proxy, cinco erros de qualquer aparelho trancavam o gerente em todos os caixas. |
| Causa | O endereco de origem do par (login + origem) ignorava DEVORA_TRUST_PROXY, enquanto o limite de taxa ja o honrava. |
| Correção | middleware/ipDeOrigem.ts: socket com DEVORA_TRUST_PROXY=0 (padrao); com N > 0, req.ip — o endereco que o salto confiavel acrescentou, com o que o cliente escreve a esquerda do X-Forwarded-For ignorado pelo Express. Usado por clientIp (bloqueio e auditoria de login, terminal, troca de senha). Mesma causa, troca minima em dominio vizinho: o bloqueio por par do portal do cliente (storefront.ts, entrar e verificar e-mail) e o ip gravado na liberacao pontual do PDV (core.ts ipDoSocket). A trava do atalho de desenvolvimento segue no socket, de proposito. O teto por login (50) continua valendo contra forca bruta distribuida. |
| DEPOIS | ipDeOrigem usa o socket quando DEVORA_TRUST_PROXY=0 e req.ip (o endereço acrescentado pelo salto confiável) quando é maior que 0. Um X-Forwarded-For forjado à esquerda é ignorado. clientIp (lockout, auditoria, terminal, troca de senha), o portal e a liberação pontual usam essa função. O teto de 50 por login continua. O backoff progressivo sugerido na correção não foi feito; ele não é o comportamento esperado da ficha. |
| Arquivos | server/src/middleware/ipDeOrigem.ts, server/src/routes/v1/auth.ts, server/src/routes/v1/storefront.ts, server/src/routes/v1/core.ts, server/tests/bloqueio-atras-do-proxy.test.ts |
| COMMIT | 38323e3 |
| TESTES | server/tests/bloqueio-atras-do-proxy.test.ts (5 casos), com proxy simulado e TRUST_PROXY=1. Cinco erros de um celular trancam só aquele celular e o gerente segue entrando. Forjar XFF não troca de aparelho. O teto por login vale. A tentativa e a trilha gravam o IP do cliente. Sem proxy, o XFF é ignorado. Rodei: verdes. |
| EVIDÊNCIA | server/src/middleware/ipDeOrigem.ts:46-50; server/src/routes/v1/auth.ts:85-86 (clientIp usa ipDeOrigem), :127 (login); server/src/routes/v1/core.ts:5735-5738; server/src/routes/v1/storefront.ts:938, :966. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | O efeito atrás do proxy depende de DEVORA_TRUST_PROXY estar configurado (é o insumo do GAP-PRD-055). |

### GAP-PRD-075 — Legado vivo: dez roteadores paralelos ao núcleo continuam montados sobre a camada de documentos (duas verdades para lead, documento fiscal, envio, terminal), e 119 das 267 tabelas vazias do banco real são coleções desse legado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DATA_INTEGRITY_RISK |
| Empresa / frente | Todas / INT |
| ANTES | Dez roteadores legados continuavam montados sobre a camada de documentos, com duas verdades para lead, documento fiscal, envio e terminal. 119 das 132 coleções do TABLE_NAMES estavam vazias. |
| Causa | A rota tinha sido mantida (GAP-PRD-064) "pelo guarda de tenant que a suíte cobra": os testes de isolamento entre empresas miravam nela, e o 200 que eles aceitavam era a linha inventada. |
| Correção | Commit 95b0e73: sai GET /system/audit (roteador), a lista em memória com defaultStubEntries/appendSystemAuditBackendForTests/listSystemAuditBackend/sanitizeSystemAuditMetadata (SystemAdminService), o caminho do OpenAPI e o módulo system-audit da matriz (nenhuma rota viva o cobrava). Os testes que usavam a rota como alvo do guarda de empresa passam a cobrar o recorte na trilha que existe (GET /core/audit), com linha gravada nas duas empresas: prompt29 (gestor da Gringa pedindo o Preço Justo pela query não vê a linha do vizinho e vê a da casa), adm-preso (adm da Conceito e dono do grupo pedindo a Gringa pela query leem só a empresa do token) e, nos três e em prompt27, a porta antiga responde 404; prompt26 fica só com o caso do release. |
| DEPOIS | /crm, /automations, /bi, /integrations, /fiscal*, /sync e /system/audit saíram, com serviços e OpenAPI. Só /logistics, /payment-terminals e /system ficam montados, e os três têm tela. O envio grava só em core_shipments. TABLE_NAMES caiu para 20 coleções. Existe o comando db:podar-legado para apagar as aposentadas vazias no banco antigo. Ficam montadas sem tela, com um escritor só e declaradas no inventário: /logistics/quotes e /logistics/homologation, a homologação e a recuperação da maquininha, e /asaas/status, /asaas/queue e o retry. Nenhuma cria lead, nota, envio ou cobrança fora do núcleo. |
| Arquivos | server/src/routes/v1/system-admin.ts, server/src/services/system-admin/SystemAdminService.ts, server/src/openapi/spec.ts, server/src/services/auth/Permissions.ts, server/tests/o-legado-sem-consumidor-sai-do-ar.test.ts, server/tests/adm-preso-a-sua-loja.test.ts, server/tests/prompt26-audit-compliance.test.ts, server/tests/prompt27-security-identity.test.ts, server/tests/prompt29-operational-homologation.test.ts |
| COMMIT | 905e2a1, 4de4ad7, 5d963aa, 07f1eed, 19632aa, 95b0e73 |
| TESTES | server/tests/o-legado-sem-consumidor-sai-do-ar.test.ts: rotas antigas dão 404; o lead tem um escritor só; roteadores e serviços saíram da árvore; o openapi não descreve /crm, /automations, /bi, /sync, /integrations, /system/staging nem /system/audit; lista fechada de prefixos montados. Rodei: verde. um-escritor-por-conceito.test.ts existe; não rodei. |
| EVIDÊNCIA | server/src/routes/v1/index.ts:88-142 (montagens e a nota do que saiu); server/src/db/database.ts TABLE_NAMES = 20 entradas (contei); server/src/services/logistics/EnvioDoPedidoService.ts:894 e :1219 (INSERT INTO core_shipments); src/lib/api/envios.ts:122-164 e src/lib/api/maquininhas.ts:327-410 (consumidores de /logistics e /payment-terminals); server/src/scripts/podar-tabelas-aposentadas.ts:1-24. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-076 — Módulo de maquininha não tem tela: configuração, credencial, teste de conexão, Local Agent, homologação, dashboard, dead-letter só por API

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / MISSING_IMPLEMENTATION (após refutação: P2 / MISSING_IMPLEMENTATION) |
| Empresa / frente | Todas / PAG |
| ANTES | O módulo de maquininha não tinha tela: configuração, credencial, teste de conexão, agente local, homologação, dashboard e dead-letter só por curl. |
| Causa | O modulo foi escrito so no servidor; nenhuma tela o consumia. |
| Correção | Pagina Configuracoes > Maquininhas (/sistema/configuracoes/maquininhas, QUEM_GERENCIA_A_OPERACAO no menu e na rota, igual ao servidor): prontidao com o que falta pelo nome; tabela de maquininhas (caixa, caminho, agente online/TEF, ligada/desligada, prontidao) com Nova maquininha (adquirente, caminho agente local — nuvem desabilitada com o motivo —, nome, identificador, caixa), Editar, Credencial (cofre, campo senha), Testar conexao, Ligar/Desligar com motivo e a recusa do servidor como veio; Agente local (gerar codigo para o caixa com o comando do agente, lista com ultimo sinal/cliente TEF/PinPad/versao, revogar com motivo); Homologacao por evidencia (x de 6 obrigatorios); Cobrancas recentes com os numeros do painel, comprovante e segunda via, cancelar/estornar (202 pelo agente), consultar no aparelho a nao confirmada; Fila do agente (pendentes e vencidos = dead-letter). Cliente src/lib/api/maquininhas.ts ampliado (sem companyId: escopo pela sessao). |
| DEPOIS | A página Configurações > Maquininhas, restrita a quem gerencia a operação, tem: prontidão com o que falta; cadastro com o caminho do agente local e a nuvem desabilitada com o motivo; editar; credencial em campo de senha para o cofre; testar conexão; ligar e desligar com motivo; gerar código de pareamento com o comando do agente; lista de agentes e revogação com motivo; homologação por evidência; cobranças recentes com cancelar, estornar e consultar no aparelho; fila do agente (pendentes e vencidos). |
| Arquivos | src/pages/gs/MaquininhasPage.tsx, src/lib/api/maquininhas.ts, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, src/router/__tests__/environments.test.tsx, src/pages/gs/__tests__/audit-portas.test.tsx, src/pages/gs/__tests__/maquininhasPage.test.tsx, server/src/routes/v1/payment-terminals.ts |
| COMMIT | aed8148, a1fdfcd |
| TESTES | src/pages/gs/__tests__/maquininhasPage.test.tsx: prontidão pelo nome; cadastro com o canal do agente e a nuvem desabilitada; credencial em campo de senha; testar conexão; ligar com motivo; código de pareamento; revogar; homologação; consultar no aparelho; último pedido de estorno. Servidor: maquininha-pelo-agente-local.test.ts. Rodados: verdes. |
| EVIDÊNCIA | src/pages/gs/MaquininhasPage.tsx:178 (página), :379 (testarConexao), :520 e :752-814 (credencial), :544-545 (ligar/desligar), :604 (cadastrar), :852-870 (código de pareamento), :969 (revogar agente), :990-1013 (homologação), :1119 (consultar no aparelho), :1277-1278 (cancelar/estornar), :1379 (fila do agente); src/router/gsRoutes.tsx:356-359 (rota com QUEM_GERENCIA_A_OPERACAO); src/lib/api/maquininhas.ts. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-077 — PIX no balcão é lançamento manual: não há intent Asaas para venda, não há QR na tela, o webhook não trata origem 'sale' e uma linha de pagamento 'pending' nunca liquida

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas (cinco lojas + Oficina) / FIN |
| ANTES | O PIX no balcão era lançamento manual e a tela prometia um QR que não existia. Não havia intent com origem 'sale', o webhook não tratava 'sale', e uma linha 'pending' nunca liquidava. |
| Causa | o PIX do balcao nao passava pelo provedor de cobranca e o estado pending nao tinha quem o liquidasse |
| Correção | Servidor: PdvPixService (status, gerar QR na conta da operacao com intencao origem sale em rascunho pdv-pix:<referencia> e pagador pelo cliente ou CPF informado, consultar lendo o ERP ou perguntando ao provedor, cancelar no provedor, fila de pendentes, confirmar pendente perguntando ao provedor ou com nota obrigatoria sem provedor); PdvPixDaVenda (confere a linha com paymentIntentId: operacao, valor, metodo, uso unico, e o STATUS vem da cobranca; vincula a cobranca a venda na transacao; liquida a linha pendente e baixa o titulo da venda por settleEntry 'Asaas <ref>'; venda cancelada -> paid_after_cancel); SalesService confere/vincula e grava payment_intent_id/settled_at; webhook e consulta ao provedor (GAP-PRD-016) ganham o ramo sale; conciliacao compara o PIX do balcao com a linha do PIX (sem acusar a parte em dinheiro). Rotas /core/pdv/pix-asaas (status, POST, GET :id ?consultar=1, POST :id/cancel), /core/pdv/pix-pendentes e /core/sales/:id/payments/:paymentId/confirmar, com auditoria. Tela: PagamentoDialog 'Gerar QR do PIX' + PixDoBalcaoPainel (QR, copia-e-cola, consulta a cada 3 s, 'Ja pagou?', 'Receber depois', 'Desistir e cancelar o QR'), texto que prometia QR corrigido, caminho manual preservado; Contas a receber ganha PixPendentesDoBalcaoCard para a gerencia. |
| DEPOIS | PdvPixService gera o QR na conta da operação (intent origem 'sale', rascunho pdv-pix:), consulta, cancela no provedor e lista a fila de pendentes. A confirmação de pendente pergunta ao provedor, ou exige nota quando o PIX não passou pelo provedor. A venda confere e vincula a cobrança. O webhook e a passada de sincronização ganharam o ramo 'sale', que liquida core_sale_payments e baixa o título por settleEntry 'Asaas <ref>'. As rotas têm perfis e auditoria. PagamentoDialog tem 'Gerar QR do PIX' com o PixDoBalcaoPainel; o caminho manual continua, com texto honesto. |
| Arquivos | server/src/services/core/PdvPixService.ts, server/src/services/core/PdvPixDaVenda.ts, server/src/services/core/SalesService.ts, server/src/services/core/PaymentService.ts, server/src/services/core/AsaasReconciliation.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, src/components/gs/PagamentoDialog.tsx, src/components/gs/PixDoBalcaoPainel.tsx, src/components/gs/PixPendentesDoBalcaoCard.tsx, src/lib/api/pixBalcao.ts, src/lib/api/core.ts, src/pages/gs/ContasPage.tsx, docs/audits/remediacao/migracoes/FIN.md, server/tests/pix-do-balcao-via-asaas.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/__tests__/pdvPixPeloAsaas.test.tsx, src/pages/gs/__tests__/pixPendentesDoBalcao.test.tsx |
| COMMIT | 9c16486 |
| TESTES | server/tests/pix-do-balcao-via-asaas.test.ts (18 casos): QR na conta da operação e idempotente; recusa sem CPF; PIX pago antes de fechar → linha settled; PIX em aberto → a venda fecha pending e o webhook liquida a linha e baixa o título (reenvio não baixa de novo); conciliação sem acusar a parte em dinheiro; webhook perdido → a passada liquida; travas de uso único, valor e operação; desistir cancela no provedor; venda cancelada → paid_after_cancel; fila e confirmação; perfis das rotas. src/components/gs/__tests__/pdvPixPeloAsaas.test.tsx (6 casos) e src/pages/gs/__tests__/pixPendentesDoBalcao.test.tsx (4 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/PdvPixService.ts:113-222, 229-259, 265-310, 332-361, 372-426; server/src/services/core/PdvPixDaVenda.ts:74-133, 158-207, 216-258, 268-292; server/src/services/core/SalesService.ts:545, 2460; server/src/services/core/PaymentService.ts:1234-1249; server/src/routes/v1/core.ts:4527-4652; src/components/gs/PagamentoDialog.tsx:576-594, 1019-1088; src/pages/gs/ContasPage.tsx:844 (PixPendentesDoBalcaoCard) |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A credencial Asaas da operação e o webhook cadastrado (GAP-PRD-002). Sem a credencial, o balcão diz que o PIX é manual. |

### GAP-PRD-078 — PIX na maquininha abandonado na tela e pago depois vira dinheiro órfão: transação aprovada sem venda, fora da fila de conferência

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / DATA_INTEGRITY_RISK (após refutação: P2 / DATA_INTEGRITY_RISK) |
| Empresa / frente | Qualquer operação com maquininha configurada (hoje: Preço Justo/mock) / PAG |
| ANTES | 'Desistir desta cobrança' só limpava a tela. O PIX pago depois virava transação aprovada sem venda, fora de qualquer fila de conferência. |
| Causa | Tres faltas: o desistir era so de tela; nao havia fila para cobranca em andamento/aprovada sem venda (listUncertainPayments filtra so a nao confirmada); e o PIX da maquininha nunca era conferido nem carimbado na venda, entao nem dava para separar o PIX que pagou venda do PIX orfao. |
| Correção | CobrancasSemVenda.ts: desistirDaCobranca (o operador desiste da cobranca que ELE fez, o gerente de qualquer uma; cancela pelo caminho do modulo cancelPaymentTerminalTransactionBackend, que so muda estado com a confirmacao do provedor), listarPendenciasDaMaquininha (em andamento ou aprovada, sem venda, sem tratativa, ha mais de N minutos - padrao 10, ?minutos= - mais os estornos a fazer), registrarTratativa (motivo >= 3, historico without_sale_handled, auditoria pdv.terminal.sem_venda.tratada) e vincularCobrancaAVenda (por id ou numero da venda; exige venda concluida e linha do mesmo meio e valor, liquidada e sem cobranca; grava provider_ref na linha, carimba saleId, historico e auditoria pdv.terminal.sem_venda.vinculada). Rotas GET /core/pdv/terminal/pendencias e POST /:id/tratativa\|vincular-venda\|estorno-manual (gerente_loja/gerente_oficina), POST /:id/desistir (BALCAO_E_GERENCIA). createSale confere e carimba o PIX cuja providerRef e cobranca da maquininha desta empresa (aprovada, mesmo valor, nao gasta); referencia de provedor de cobranca segue livre. Tela: PagamentoDialog desiste de verdade (e o remover da linha que veio do aparelho tambem); recusado, a cobranca fica na tela com o motivo; card PendenciasDaMaquininhaCard na Conferencia de maquininha com prazo, cancelar na operadora, amarrar pelo numero da venda e registrar tratativa. |
| DEPOIS | Desistir no PDV chama o servidor, que cancela pelo caminho do módulo (o estado só muda com a confirmação do provedor); o operador só desiste da própria cobrança. A fila 'cobranças sem venda' mostra as em andamento ou aprovadas, sem venda e sem tratativa, há mais de N minutos (padrão 10), só para a gerência. O gestor amarra a uma venda (mesmo meio e valor), registra tratativa com motivo e auditoria, ou cancela na operadora. Um PIX da maquininha usado numa venda é carimbado e não paga duas vendas. |
| Arquivos | server/src/services/core/CobrancasSemVenda.ts, server/src/services/core/PdvTerminalService.ts, server/src/services/core/SalesService.ts, server/src/routes/v1/core.ts, server/tests/pendencias-eletronicas-da-maquininha.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/PagamentoDialog.tsx, src/components/gs/PendenciasDaMaquininhaCard.tsx, src/pages/gs/ConferenciaMaquininhaPage.tsx, src/lib/api/maquininhas.ts, src/components/gs/__tests__/pendenciasEletronicas.test.tsx, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | 5f4d843, 3447674 |
| TESTES | server/tests/pendencias-eletronicas-da-maquininha.test.ts: o PIX deixado na tela aparece em semVenda como 'processando' e continua lá como 'aprovado' depois de pago; prazo respeitado; o caixa não lista (403); o PIX que paga a venda é carimbado e sai da fila; PIX pendente não paga venda (409); o mesmo PIX não paga duas vendas; desistir cancela no provedor com tentativa 'confirmed'; o caixa só desiste da própria; tratativa e vínculo com auditoria; outra empresa isolada. Tela: src/components/gs/__tests__/pendenciasEletronicas.test.tsx. Rodados: verdes. |
| EVIDÊNCIA | server/src/services/core/CobrancasSemVenda.ts:109-147 (ehSemVenda e listarPendenciasDaMaquininha), :161-202 (desistirDaCobranca com dono e cancelamento real), :212 (registrarTratativa), :278-401 (vincularCobrancaAVenda com auditoria); server/src/routes/v1/core.ts:4728-4825 (pendencias, desistir, tratativa, vincular-venda, estorno-manual com os perfis certos); src/components/gs/PagamentoDialog.tsx:785-800, :1117, :1202 (desistir chama o servidor); src/pages/gs/ConferenciaMaquininhaPage.tsx:129 (PendenciasDaMaquininhaCard). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-079 — Cancelar/estornar transação de provedor real pelas rotas do módulo grava 'cancelled'/'refunded' sem nada acontecer no provedor

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / BUG (após refutação: P2 / BUG) |
| Empresa / frente | Todas (quando houver provider real) / PAG |
| ANTES | As rotas de cancelar e estornar gravavam 'cancelled'/'refunded' por padrão quando o provedor real respondia pendente sem status, e não conferiam o saleId. |
| Causa | As rotas de cancel/refund gravavam o estado pelo `??` da ausencia de resposta e nao olhavam estado de origem, venda amarrada nem trava do mock. |
| Correção | cancelPaymentTerminalTransactionBackend/refundPaymentTerminalTransactionBackend: 404 entre empresas, 409 PAYMENT_TERMINAL_TRANSACTION_BOUND_TO_SALE nomeando a venda, 409 de estado de origem (cancelar: authorized/confirmed/in_progress fora de voo/timeout_uncertain; estornar: authorized/confirmed/partially_refunded), motivo obrigatorio, estorno parcial com teto (400 PAYMENT_TERMINAL_REFUND_AMOUNT_INVALID), trava do mock, trava por transacao contra pedido duplo; pedirAoProvedor so grava novo estado com result.ok — pending 409 PAYMENT_TERMINAL_PROVIDER_PENDING, recusa 409, excecao 502 — e registra cada tentativa em payment_terminal_cancellations/refunds; historico + auditoria na confirmacao; o adaptador recebe a referencia da cobranca (id/NSU/valor) e aplica a trava do mock; STATUS_MAP do balcao conhece refunded/partially_refunded. |
| DEPOIS | O estado só muda com result.ok. Pendente dá 409 PAYMENT_TERMINAL_PROVIDER_PENDING, recusa dá 409, exceção dá 502, e cada tentativa fica registrada em payment_terminal_cancellations/refunds. Cobrança amarrada a venda dá 409 nomeando a venda (salvo o 'a estornar' de venda desfeita). Há conferência do estado de origem (failed não se cancela nem se estorna), motivo obrigatório, teto do estorno parcial, trava do mock e trava contra pedido duplo. Pelo agente local, o pedido vai para a fila (202). |
| Arquivos | server/src/routes/v1/payment-terminals.ts, server/src/services/payment-terminal/PaymentTerminalService.ts, server/src/services/payment-terminal/PaymentTerminalProviderAdapter.ts, server/src/services/core/PdvTerminalService.ts, server/tests/maquininha-estorno-e-comprovante-honestos.test.ts |
| COMMIT | 25fce09 |
| TESTES | server/tests/maquininha-estorno-e-comprovante-honestos.test.ts: Stone authorized com cancel/refund dá 409 PAYMENT_TERMINAL_PROVIDER_PENDING, o status continua 'authorized' e a tentativa fica com outcome pending_provider; Stone 'failed' não vira cancelled nem refunded; amarrada à venda 42 dá 409 BOUND_TO_SALE citando 42; mock em teste confirma e audita; estorno parcial com teto; outra empresa 404; mock em produção travado. Rodado: verde. |
| EVIDÊNCIA | server/src/services/payment-terminal/PaymentTerminalService.ts:953-955 (estados de origem), :975-998 (exigirSemVenda), :1034-1079 (pedirAoProvedor: só ok grava; pending/declined 409; erro 502), :1081-1096 (trava), :1098-1223 (cancel/refund com 404, motivo, teto, mock); server/src/routes/v1/payment-terminals.ts:473-501 (as rotas só traduzem; 202 quando vai ao agente). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-080 — Cancelamento de venda e devolução 'cartao' não estornam nem desvinculam a cobrança da maquininha

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Operações com maquininha configurada / PAG |
| ANTES | Cancelar a venda ou devolver no cartão não tocava a cobrança da maquininha. Ela continuava 'authorized', presa à venda cancelada, sem estorno e sem rastro. |
| Causa | cancelSale e createSaleReturn nao conheciam payment_terminal_transactions (o comentario dizia "volta pela operadora"), e a trava do P1 (exigirSemVenda) nao distinguia venda viva de venda desfeita. |
| Correção | EstornoNaMaquininha.ts: marcarCobrancasAEstornar roda DENTRO da transacao do cancelamento (tudo o que ainda pode voltar) e da devolucao estorno_cartao (o valor devolvido, distribuido pelas cobrancas de cartao; acima do que elas podem estornar -> 409 CORE_RETURN_CARD_EXCEEDS_TERMINAL antes de gravar), gravando aEstornarCents, estornosPedidos, historico refund_requested_by_sale e auditoria pdv.terminal.estorno_a_fazer; executarEstornosPendentes roda DEPOIS do commit nas rotas /sales/:id/cancel e /sale-returns e pede o estorno pelo caminho do modulo (mock na hora, agente pela fila), respondendo estornosNaMaquininha (estornado / enviado_ao_agente / pendente com o motivo), sem nunca desfazer o cancelamento; registrarEstornoManual (gerencia, motivo, via manual, auditoria pdv.terminal.estorno_manual) para o estorno feito no proprio aparelho. exigirSemVenda deixa passar so o valor a estornar (estorno ate o teto; cancelamento so se cobre a cobranca inteira); aplicarEstornoConfirmado/aplicarCancelamentoConfirmado baixam o aEstornarCents; nova via manual. Tela: fila "Estornos a fazer" na Conferencia (pedir de novo, estornado no aparelho) e a DevolucoesPage diz o que houve com o estorno (ou que nao ha cobranca integrada e o estorno e no aparelho). |
| DEPOIS | Dentro da transação, cancelSale e createSaleReturn (estorno_cartao) marcam a cobrança como 'a estornar', com histórico e auditoria. Depois do commit, as rotas pedem o estorno à operadora e respondem estornosNaMaquininha. O que a operadora não confirma fica na fila 'Estornos a fazer', onde o gerente pede de novo ou registra o estorno manual, com motivo. |
| Arquivos | server/src/services/core/EstornoNaMaquininha.ts, server/src/services/core/SalesService.ts, server/src/services/core/SaleReturnService.ts, server/src/services/payment-terminal/PaymentTerminalService.ts, server/src/services/payment-terminal/PaymentTerminalTransactionEffects.ts, server/src/routes/v1/core.ts, server/tests/pendencias-eletronicas-da-maquininha.test.ts, src/components/gs/PendenciasDaMaquininhaCard.tsx, src/pages/gs/DevolucoesPage.tsx, src/lib/api/core.ts, src/lib/api/maquininhas.ts, src/components/gs/__tests__/pendenciasEletronicas.test.tsx |
| COMMIT | 5f4d843, 3447674 |
| TESTES | server/tests/pendencias-eletronicas-da-maquininha.test.ts:379-604. Afirma: cancelar deixa a cobrança 'refunded' com payment_terminal_refunds 'confirmed' e auditoria; devolução parcial estorna só o valor devolvido; estorno acima do que o cartão integrado pagou dá 409 sem gravar; operadora sem confirmação deixa a venda cancelada e a cobrança na fila aEstornar; estorno manual exige motivo e é só da gerência (403 para o operador). src/components/gs/__tests__/pendenciasEletronicas.test.tsx cobre a fila e as frases. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/core/EstornoNaMaquininha.ts:100-192 (marca, refund_requested_by_sale, auditoria pdv.terminal.estorno_a_fazer, 409 CORE_RETURN_CARD_EXCEEDS_TERMINAL), :200-247 (executa sem desfazer o cancelamento), :257-324 (estorno manual); SalesService.ts:2691; SaleReturnService.ts:704-715; routes/v1/core.ts:6222 e :15052 (depois do commit), :4810-4825 (estorno-manual só gerente); PaymentTerminalService.ts:975-998 (exigirSemVenda deixa passar só o valor a estornar); src/components/gs/PendenciasDaMaquininhaCard.tsx:187-202,336-343; src/pages/gs/DevolucoesPage.tsx:315,633. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-081 — Fechamento de caixa não bloqueia com cobrança de maquininha não confirmada nem com PIX pendente na venda

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / PAG |
| ANTES | closeSession fechava o turno em silêncio. Isso valia com cobrança timeout_uncertain e com PIX pending em venda do turno. |
| Causa | closeSession so olhava os movimentos da gaveta; payment_terminal_transactions e core_sale_payments pending nunca eram consultados, e a cobranca do PDV nao carregava caixa nem turno. |
| Correção | PendenciasDoTurno.ts: pendenciasEletronicasDoTurno (nao confirmada, em andamento, aprovada sem venda, estorno pendente; mais pagamento pending de venda concluida da gaveta), com a cobranca ligada ao turno pelo carimbo cashSessionId (chargeOnTerminal grava cashSessionId e pdvTerminalId) ou, sem carimbo, pela janela do turno no mesmo caixa. closeSession recusa com 409 CORE_CASH_CLOSE_ELECTRONIC_PENDING nomeando cada pendencia e o total; fechar exige pendenciasCiente + pendenciasMotivo (>= 3; senao 400 CORE_CASH_CLOSE_PENDING_REASON_REQUIRED) e grava o que ficou pendente em core_cash_sessions.closed_with_pending (coluna nova anulavel pela DDL canonica) e na auditoria cash.close; reopenSession arquiva e limpa. getSummary devolve pendenciasEletronicas do turno aberto. Tela: PendenciasDoFechamento (lista, ciencia e motivo) no CaixaPdvDialog (a partir do resumo; a lista da recusa do servidor vence), em Vendas > Caixa e nas Gavetas abertas da operacao. |
| DEPOIS | closeSession recusa com 409 CORE_CASH_CLOSE_ELECTRONIC_PENDING e lista cada pendência: não confirmada, em andamento, aprovada sem venda, estorno pendente, pagamento pending e venda offline. Para fechar, o operador declara ciência e motivo (menos de 3 caracteres dá 400). O fechamento grava closed_with_pending e auditoria. O resumo já avisa. A tela mostra as pendências no CaixaPdvDialog, em Vendas > Caixa e em Gavetas abertas. |
| Arquivos | server/src/services/core/PendenciasDoTurno.ts, server/src/services/core/CashService.ts, server/src/services/core/PdvTerminalService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/pendencias-eletronicas-da-maquininha.test.ts, src/components/gs/PendenciasDoFechamento.tsx, src/lib/pendenciasDoFechamento.ts, src/components/gs/CaixaPdvDialog.tsx, src/components/gs/GavetasAbertas.tsx, src/pages/gs/OperacaoPages.tsx, src/lib/api/core.ts, src/components/gs/__tests__/pendenciasEletronicas.test.tsx, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | 5f4d843, 3447674 |
| TESTES | server/tests/pendencias-eletronicas-da-maquininha.test.ts:607-750. Afirma: 409 com a cobrança timeout_uncertain e o turno ainda aberto; PIX pending trava; aprovada sem venda e em andamento contam; ciente sem motivo dá 400, com motivo fecha e grava closed_with_pending e cash.close; a pendência continua na fila do gerente; pendência do caixa ao lado não trava; reabrir limpa. Tela: pendenciasEletronicas.test.tsx:305-443. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/core/CashService.ts:470-516; PendenciasDoTurno.ts:92-176 (cobrança do turno pelo carimbo cashSessionId ou pela janela e pelo caixa; PIX pending por s.cash_session_id); routes/v1/core.ts:4255-4256; CashService.ts:819 (resumo); src/components/gs/CaixaPdvDialog.tsx:770, GavetasAbertas.tsx:174, OperacaoPages.tsx:1645. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-082 — Impressão silenciosa e gaveta por comando dependem de um agente local que não existe; ESC/POS é gerado sem consumidor

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / PAG |
| ANTES | O cupom saía só pelo diálogo do navegador. O ESC/POS era gerado, mas nenhum programa o consumia. A gaveta 'por comando' era prometida só porque havia um cadastro 'agent'. |
| Causa | O transporte 'agent' existia so no cadastro: nenhum consumidor da fila de impressao, nenhuma rota para o agente, e a prontidao da gaveta respondia pela existencia do cadastro. |
| Correção | Servidor: impressora de agente com caixa (core_printers.pdv_terminal_id) e endereco no computador do caixa (agent_device: tcp:IP:porta, \\PC\FILA, COMn, LPTn — destinoDaImpressora, o mesmo codigo no servidor e no agente); createPrintJob decide o transporte no nascimento (agente so com endereco + agente daquele caixa pareado e no ar + documento termico; senao navegador com fallback_reason). PrintAgentQueue: retirada atomica por caixa em long-poll, ESC/POS de todas as vias (pulso so na primeira), prazos (10 min retirar, 1 min o pulso da gaveta que nunca abre depois, 2 min confirmar), resultado idempotente so do agente que retirou, confirmacao atrasada vale, trilha cash.drawer.opened_by_command e print.job.agent_failed. Rotas GET /payment-terminals/agent/print-jobs e POST .../:id/result (HMAC do pareamento), GET /core/print/jobs/:id, POST /core/print/printers/:id/test (gerencia), POST /core/print/drawer/open (balcao, motivo), /print/drawer por caixa, POST /print/jobs com caixa e openDrawer, PRINTER_TEST/DRAWER_PULSE reservados (sem POST generico nem segunda via), segunda via sem gaveta, pagina de teste em ESC/POS e prontidao por impressora (AGENT_READY so com teste confirmado); POST /print/printers passou a usar a empresa da sessao. Agente: ClienteDoServidor.impressoes/resultadoDaImpressao, PonteImpressora (socket cru, compartilhamento, serial, paralela, endereco conferido de novo), ImpressorDoAgente (imprime uma vez, reenvia o resultado que nao chegou sem reimprimir), PonteSemTef e parear --sem-tef; rodar anda com PinPad e impressora juntos. Tela: Configuracoes > Impressoras com caixa, endereco, situacao do agente, o que falta e Imprimir teste acompanhado ate o agente confirmar; printDocument espera o agente em vez de abrir janela; o PDV manda o cupom ao agente no Finalizar (gaveta so com dinheiro) quando a termica do caixa esta no ar; Abrir gaveta (AbrirGavetaPorComando) no dialogo do caixa so com o agente no ar e com motivo. docs/OPERATIONS.md: instalacao do agente de impressao. |
| DEPOIS | O agente local existe e o ciclo fecha de ponta a ponta. Ele retira os jobs por HMAC em long-poll, escreve na porta (tcp, compartilhamento, COM ou LPT) e devolve printed ou failed sem reimprimir. Na tela: cadastro com caixa e endereço, teste acompanhado, e o PDV manda o cupom ao agente no Finalizar, abrindo a gaveta só com dinheiro. Sem agente no ar, o cupom volta ao navegador e diz por quê. |
| Arquivos | server/src/db/schema.ts, server/src/services/core/PrintEngine.ts, server/src/services/core/PrintAgentQueue.ts, server/src/services/core/destinoDaImpressora.ts, server/src/services/core/EscPos.ts, server/src/routes/v1/core.ts, server/src/routes/v1/payment-terminals.ts, server/src/local-agent/ClienteDoServidor.ts, server/src/local-agent/PonteImpressora.ts, server/src/local-agent/ImpressorDoAgente.ts, server/src/local-agent/PonteSemTef.ts, server/src/local-agent/main.ts, server/tests/impressao-pelo-agente-local.test.ts, server/tests/agente-local-impressora.test.ts, server/tests/gaveta-e-cupom-termico.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/core.ts, src/lib/api/impressao.ts, src/lib/print.ts, src/pages/gs/ImpressorasPage.tsx, src/pages/gs/PdvPage.tsx, src/components/gs/AbrirGavetaPorComando.tsx, src/components/gs/CaixaPdvDialog.tsx, src/pages/gs/__tests__/impressaoPeloAgente.test.tsx, docs/OPERATIONS.md, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | 38f97c4, d6269dd |
| TESTES | server/tests/impressao-pelo-agente-local.test.ts (13 casos): pulso da gaveta antes do corte; 'impresso' só com a confirmação do agente; segunda via sem gaveta; sem agente, cai no navegador com o motivo; cada agente vê só o seu caixa e a sua empresa; pedido sem assinatura é recusado; pulso vencido nunca abre; AGENT_READY só com o teste confirmado; empresa vem da sessão. server/tests/agente-local-impressora.test.ts: formatos de endereço, socket de mentira e a volta que falha. gaveta-e-cupom-termico.test.ts. Tela: impressaoPeloAgente.test.tsx. Rodei tudo: verde. |
| EVIDÊNCIA | server/src/local-agent/main.ts:108-145 (rodar executa a fila de impressão junto com o PinPad; --sem-tef em :84); ImpressorDoAgente.ts:68-107; routes/v1/payment-terminals.ts:179-206 (GET /agent/print-jobs e POST .../:id/result com HMAC); routes/v1/core.ts:1572,1644,1666,1715 (job, gaveta, abrir gaveta, teste); src/pages/gs/PdvPage.tsx:1760-1773; docs/OPERATIONS.md:92-120 (instalação). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_HARDWARE_REQUIRED** — Equipamento externo |
| Insumo externo | Por balcão: impressora térmica ESC/POS (rede na porta 9100, USB compartilhada, serial ou paralela). No computador do caixa: Node 22+ com server/dist e o agente pareado em Configurações > Maquininhas > Agente local (--sem-tef se não houver PinPad), rodando como serviço (NSSM ou Agendador). Depois, cadastrar a impressora com caixa e endereço em Configurações > Impressoras e confirmar a página de teste. Com isso em mãos, nenhuma linha de código. |

### GAP-PRD-083 — Taxas/prazos de operadora não cadastrados no banco real: cartão liquida no mesmo dia pelo valor bruto

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Todas (core_acquirer_rates vazia; 1 operadora 'ZZ-TESTE' inativa na PJ) / PAG |
| ANTES | core_acquirer_rates está vazia no banco real. O cartão liquida no dia pelo valor bruto, e a prontidão não dizia qual operação estava sem taxa. |
| Causa | Taxa e prazo de cada contrato de operadora sao dado do dono; o sistema so nao os apontava na prontidao. |
| Correção | pendenciasDeConfiguracao em CoreProductionReadinessService: por operacao, operadora sem taxa ATIVA (quem: dono; onde: Financeiro > Operadoras de cartao), exposta em evaluateCoreProductionReadiness().configurationPending (/system/readiness e /system/go-live) sem mudar o coreStatus. GO_LIVE_CHECKLIST e ESTADO-ATUAL com o item. |
| DEPOIS | O cadastro existe por tela e por rota: Financeiro > Operadoras de cartão, /core/acquirers e PUT /acquirers/:id/rates. planForPayment lê a taxa ativa por meio de pagamento e número de parcelas, e a venda nasce em parcelas com data de repasse e taxa. Sem taxa, segue o caminho declarado. A prontidão de go-live lista, por operação, a falta de taxa, sem bloquear o núcleo. |
| Arquivos | server/src/services/system-admin/CoreProductionReadinessService.ts, server/tests/prontidao-das-operacoes.test.ts, docs/GO_LIVE_CHECKLIST.md, docs/ESTADO-ATUAL.md |
| COMMIT | d6269dd |
| TESTES | server/tests/prontidao-das-operacoes.test.ts (5 casos): sem taxa aparece a pendência com quem e onde; cadastrada, some só daquela operação; operadora desativada não conta; coreStatus inalterado. Rodei: verde. Não rodei prazos-e-taxas nem dinheiro-em-centavos-exatos neste lote (a suíte inteira do servidor está verde em 1078ddb). |
| EVIDÊNCIA | server/src/services/core/AcquirerService.ts:245-289; SalesService.ts:2103-2123 (a venda usa o plano); routes/v1/core.ts:10899-11017; src/router/gsRoutes.tsx:408-413 (/sistema/financeiro/operadoras); CoreProductionReadinessService.ts:107-131 e :231 (configurationPending); docs/GO_LIVE_CHECKLIST.md:90. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel, com gerente e contador de cada uma das seis operações: em Financeiro > Operadoras de cartão, cadastrar a operadora e, por forma de pagamento e número de parcelas, a taxa (bps) e o prazo de repasse de cada contrato de maquininha. |

### GAP-PRD-084 — Escopo cruzado do BI e do painel por operação segue o VÍNCULO e ignora o PERFIL naquele vínculo — gerente em A lê o faturamento de B onde é só mecânico

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | Todas (qualquer usuário com vínculo em mais de uma empresa com perfis diferentes) / SEG |
| ANTES | /dashboard?companyId= e o BI (companiesOf) seguiam só o vínculo. Um gerente em A lia o faturamento de B, onde era só mecânico. |
| Causa | O recorte cruzado seguia o vinculo; o guarda de cada rota so avalia o perfil da sessao, e ninguem perguntava o perfil da pessoa na operacao atravessada. |
| Correção | services/auth/AlcanceCruzado.ts: operacoesOndeOPerfilAbre(userId, perfisDaRota) com o atalho dos donos e falha fechada. companiesOf usa PERFIS_QUE_LEEM_O_BI (exportado de GroupInsights; o teste cobra que e a mesma lista do guarda das quatro rotas, escrito por extenso em core.ts por causa da varredura AST). /dashboard: seletor e ?companyId= pelo perfil do escritorio em cada operacao; vinculo sem alcance = 403 CORE_COMPANY_PROFILE_WITHOUT_ACCESS. Mesma raiz em GET /companies e /fiscal/certificates/group (so operacoes com perfil de dono la). |
| DEPOIS | operacoesOndeOPerfilAbre filtra por profile_code em cada operação, com o atalho dos donos. O BI usa PERFIS_QUE_LEEM_O_BI (gerente_loja, gerente_oficina). O /dashboard usa os perfis do escritório e recusa com 403 CORE_COMPANY_PROFILE_WITHOUT_ACCESS. GET /companies e /fiscal/certificates/group só listam onde a pessoa é dona. |
| Arquivos | server/src/services/auth/AlcanceCruzado.ts, server/src/services/core/GroupInsights.ts, server/src/routes/v1/core.ts, server/tests/bi-e-painel-seguem-o-perfil-de-cada-operacao.test.ts |
| COMMIT | 122cbbb |
| TESTES | server/tests/bi-e-painel-seguem-o-perfil-de-cada-operacao.test.ts. Gerente em Conceito e mecânico em PJ: ?companyId=PJ = 403 e 50000 não aparece. O seletor não oferece PJ. /insights/operations, products, brands e margin não incluem PJ. Estoquista não entra no BI. /companies e certificates/group seguem o perfil. A guarda e o recorte do BI usam a mesma lista. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/auth/AlcanceCruzado.ts:38-56; server/src/services/core/GroupInsights.ts:39, :191-192; server/src/routes/v1/core.ts:6883-6898 (/dashboard), :4421 e :8800 (companies e certificates/group), :16259-16261 (guarda do BI). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-085 — POST /purchases/notes/:id/link reescreve o produto de item em nota já RECEBIDA (ou estornada) sem recusar

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | Todas / EST |
| ANTES | POST /purchases/notes/:id/link não lia o status. Em nota recebida ou estornada, trocava o product_id do item com 200. |
| Causa | linkNoteItem nao lia core_inbound_notes.status (conferirItem, o vizinho, ja recusava) |
| Correção | linkNoteItem le a nota dentro de withTransaction: recebida -> 409 CORE_NOTE_ALREADY_RECEIVED (frase manda estornar e relancar), estornada -> 409 CORE_NOTE_REVERSED, qualquer outro status fora de 'conferencia' -> 409 CORE_NOTE_NOT_IN_CONFERENCE; vale para vincular e desfazer; a tela so oferece Vincular/Trocar/Desfazer com a nota em conferencia |
| DEPOIS | linkNoteItem lê o status dentro da transação e só aceita nota em conferência. Recebida dá 409 CORE_NOTE_ALREADY_RECEIVED, estornada dá 409 CORE_NOTE_REVERSED e qualquer outro status dá 409 CORE_NOTE_NOT_IN_CONFERENCE. Vale também para desfazer. A tela só mostra os botões com a nota em conferência. |
| Arquivos | server/src/services/core/NfeImportService.ts, server/tests/entrada-casamento-com-o-catalogo.test.ts, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/__tests__/EntradaNotasVinculo.test.tsx |
| COMMIT | 7b53e07 |
| TESTES | server/tests/entrada-casamento-com-o-catalogo.test.ts:178-230 (recebida 409 e product_id intacto, sem trilha; estornada pelo estorno real 409 CORE_NOTE_REVERSED; desfazer em recebida 409). src/pages/gs/__tests__/EntradaNotasVinculo.test.tsx:350-370 (recebida/estornada sem botões; atendente sem botão). Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/NfeImportService.ts:1627-1659; src/pages/gs/EntradaNotasPage.tsx:1313 (podeVincular só com status 'conferencia') |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-086 — Margem do BI usa o custo ATUAL do cadastro; o DRE usa o custo fotografado na venda — as duas telas discordam sobre o mesmo período

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / FIN |
| ANTES | marginWhereReliable somava p.cost_cents (custo atual do cadastro) × quantidade, enquanto o DRE somava o custo gravado na venda. BI e DRE davam 40% contra 60% para as mesmas vendas. |
| Causa | Duas reguas de custo: o BI lia o custo atual do cadastro, o DRE o snapshot gravado na venda. |
| Correção | marginWhereReliable soma core_sale_items.cost_cents (snapshot) com as tres populacoes do DRE (> 0 entra; = 0 skippedNoCost; NULL skippedBeforeSnapshot, sem herdar o custo de hoje) e o mesmo arredondamento por linha; BiPage declara a regua e nomeia as linhas sem custo gravado. |
| DEPOIS | marginWhereReliable soma si.cost_cents (o custo gravado na venda), com as três populações do DRE: > 0 entra, = 0 conta como skippedNoCost, NULL conta como skippedBeforeSnapshot. O arredondamento por linha é o mesmo do DRE, e não há mais JOIN com o cadastro de produto. |
| Arquivos | server/src/services/core/GroupInsights.ts, src/lib/api/core.ts, src/pages/gs/BiPage.tsx, server/tests/margem-do-bi-bate-com-o-dre.test.ts, server/tests/cmv-nasce-na-venda.test.ts, src/pages/gs/__tests__/biMargemComCustoDaVenda.test.tsx |
| COMMIT | 99fcd7c |
| TESTES | server/tests/margem-do-bi-bate-com-o-dre.test.ts (3 casos): o custo do cadastro sobe de 8000 para 12000 depois da venda e BI e DRE continuam com costCents 16000 e 60%; as três populações batem campo a campo com o DRE; linha NULL não herda o custo de hoje. src/pages/gs/__tests__/biMargemComCustoDaVenda.test.tsx (2 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/GroupInsights.ts:581-634 (SQL em 604-617 sobre core_sale_items.cost_cents) |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-087 — Conferência de reservas presas (InventoryReconciliation) não tem rota nem tela — e o banco operacional já tem uma reserva órfã

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Conceito (hoje); todas (desenho) / EST |
| ANTES | InventoryReconciliation não tinha rota nem tela. A reserva órfã da Conceito ficava invisível e não havia gesto para soltá-la. |
| Causa | o servico de conferencia de reservas nunca ganhou rota nem tela, e nao havia gesto auditado para soltar reserva sem origem |
| Correção | ReservaSemOrigemService: conferirReservas (numeros reserved/withSource no issue, referencias do razao que reservaram e nao soltaram com a situacao do documento aberta/encerrada/inexistente, abatendo o que ja foi solto) e liberarReservaSemOrigem (so gerencia, motivo obrigatorio, so a parte sem origem, conferencia refeita na transacao, kind novo ORPHAN_RESERVATION_RELEASE com motivo e autor no razao via releaseReservation com reason); rotas GET /stock/reconciliation (escritorio) e POST /stock/reservations/:productId/liberar-sem-origem (gerentes) com trilha stock.reservation.orphan_released; tela: cartao Reservas que precisam de conferencia na Posicao de estoque |
| DEPOIS | GET /stock/reconciliation (escritório) mostra os issues com as referências do razão e a situação de cada documento. POST .../liberar-sem-origem (só gerentes, motivo obrigatório) solta só a parte sem origem, dentro da transação, com kind ORPHAN_RESERVATION_RELEASE e trilha. Um cartão na Posição de estoque mostra tudo isso. |
| Arquivos | server/src/services/core/ReservaSemOrigemService.ts, server/src/services/core/InventoryReconciliation.ts, server/src/services/core/InventoryService.ts, server/src/routes/v1/core.ts, server/tests/reserva-sem-origem-tem-porta.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/reservas.ts, src/components/gs/ConferenciaDeReservas.tsx, src/pages/gs/OperacaoPages.tsx, src/pages/gs/__tests__/reservaSemOrigemNaPosicao.test.tsx |
| COMMIT | 0c22d9e |
| TESTES | server/tests/reserva-sem-origem-tem-porta.test.ts:109-280 (pedido sumido aparece como crítico, bancada fora, isolamento por empresa, gerente solta com trilha, sem motivo recusa, estoquista/atendente 403, só a parte sem origem, outra empresa 404). Tela reservaSemOrigemNaPosicao: rodado, verde. |
| EVIDÊNCIA | server/src/services/core/ReservaSemOrigemService.ts:212-226 (conferirReservas), :245-326 (liberarReservaSemOrigem: motivo, 404 outra empresa, 409 CORE_RESERVATION_HAS_SOURCE/EXCEEDS, releaseReservation com reason); server/src/routes/v1/core.ts:2903-2911, :2981-3013 (auditoria stock.reservation.orphan_released); src/components/gs/ConferenciaDeReservas.tsx:55-106,216; src/pages/gs/OperacaoPages.tsx:448 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional: a gerência solta pela tela a reserva órfã real da Conceito, informando o motivo. Não foi solta por migração. |

### GAP-PRD-088 — NF 9991 (Preço Justo, R$ 1.485,60) está RECEBIDA sem conta a pagar — precisa de decisão humana

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Preço Justo / EST |
| ANTES | A NF 9991 (Preço Justo, R$ 1.485,60) está recebida sem título a pagar, e não havia mecanismo para decidir o que fazer com ela. |
| Causa | a decisao sobre a NF 9991 e do dono, mas o software nao oferecia o mecanismo |
| Correção | NotaSemContaService: lista de notas recebidas com total > 0 sem titulo de origem propria e sem decisao, com vencimento sugerido (recebimento + prazo do fornecedor); decidirContaDaNota com tres gestos: lancar (titulo com a mesma origem da confirmacao, competencia no recebimento, categoria fornecedor, evento para a central), ja_paga (titulo + baixa inteira com data e forma) e sem_divida (justificativa gravada na nota em colunas novas anulaveis finance_waiver_*); decidir de novo e 409; rotas de gerencia com trilha purchase.note.finance_decision; tela: cartao Notas recebidas sem conta a pagar na Entrada de notas (so gerencia) |
| DEPOIS | Existe a lista de notas recebidas com total > 0 sem título e sem decisão, e os três gestos estão implementados: lançar, já paga (título + baixa) e sem dívida (justificativa gravada na nota). Decidir de novo dá 409. As rotas são de gerência, com trilha, e o cartão fica na Entrada de notas. A escolha é só dado entrado pela tela. |
| Arquivos | server/src/services/core/NotaSemContaService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/nota-recebida-sem-conta.test.ts, src/lib/api/notasSemConta.ts, src/components/gs/NotasSemContaAPagar.tsx, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/__tests__/notaSemContaNaEntrada.test.tsx, docs/audits/remediacao/migracoes/EST.md |
| COMMIT | 5a1d0e8 |
| TESTES | server/tests/nota-recebida-sem-conta.test.ts:94-215 (lista com vencimento sugerido, só gerência, isolamento por empresa, lançar/já paga/sem dívida com prova, ação inválida recusa). src/pages/gs/__tests__/notaSemContaNaEntrada.test.tsx:85-140. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/NotaSemContaService.ts:56-103 (lista), :118-280 (decidirContaDaNota com os 3 modos, 409 CORE_NOTE_FINANCE_ALREADY_DECIDED, settleEntry para ja_paga); server/src/routes/v1/core.ts:12919-12960 (gerentes, auditoria purchase.note.finance_decision); server/src/db/schema.ts:2569-2571 (finance_waiver_*); src/components/gs/NotasSemContaAPagar.tsx:25-98; src/pages/gs/EntradaNotasPage.tsx:1974 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel decide a NF 9991 pela tela: lançar a conta, lançar já paga (com data e forma) ou declarar que ela não gera conta (com justificativa). |

### GAP-PRD-089 — Devolução ao fornecedor não existe — só o estorno da nota inteira, recusado se houve baixa ou se a mercadoria já saiu

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / EST |
| ANTES | Não havia devolução ao fornecedor. Só existia o estorno da nota inteira, recusado quando houve baixa ou quando parte da mercadoria já tinha saído. |
| Causa | o unico desfazer de compra era o estorno da nota inteira |
| Correção | tabelas novas core_supplier_returns/core_supplier_return_items (DDL canonica, ordem de exclusao) e SupplierReturnService: devolviveis lidos do razao (entrou menos ja devolvido, limitado ao disponivel, pecas da nota para serializado); registrarDevolucao com saida SUPPLIER_RETURN (referencia devolucao_fornecedor, custo de entrada, motivo), financeiro em tres modos (abatimento reduz o titulo em aberto da nota sem baixa fingida e o cancela pelo carimbo se chega a zero; credito cria titulo a receber do fornecedor com origem nova devolucao_fornecedor rotulada no FinanceService e navegavel; sem_financeiro so para nota sem divida), soma dos creditos limitada ao total; gancho fiscal pendente com a chave e a finalidade 4 na frase, resolvido por chave valida (44 digitos, DV, modelo 55, nao a da entrada), nota do fornecedor ou dispensa justificada; estornarNota recusa nota com devolucao; rotas devolviveis e supplier-returns (leitura gerentes+estoquista, escrita gerencia) com trilha; tela nova Compras > Devolucoes ao fornecedor, botao Devolver na Entrada de notas, menu e rota com QUEM_DEVOLVE_AO_FORNECEDOR |
| DEPOIS | A devolução parcial está implementada. Tem itens limitados ao que é devolvível, saída SUPPLIER_RETURN com referência própria, abatimento do título em aberto ou crédito a receber (limitado ao total da nota), e gancho fiscal pendente com a chave da nota e a finalidade 4. A nota com devolução não pode mais ser estornada. Há tela, menu e botão Devolver. |
| Arquivos | server/src/services/core/SupplierReturnService.ts, server/src/services/core/FinanceService.ts, server/src/services/core/NfeImportService.ts, server/src/services/core/PurchaseOrderService.ts, server/src/services/core/InventoryService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/devolucao-ao-fornecedor.test.ts, server/tests/titulo-e-origem-sao-navegaveis.test.ts, src/pages/gs/DevolucoesFornecedorPage.tsx, src/lib/api/devolucoesFornecedor.ts, src/lib/rotasDeOrigem.ts, src/components/gs/navItems.ts, src/router/gsRoutes.tsx, src/router/__tests__/environments.test.tsx, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/__tests__/devolucaoAoFornecedor.test.tsx, docs/audits/remediacao/migracoes/EST.md |
| COMMIT | e3e0735 |
| TESTES | server/tests/devolucao-ao-fornecedor.test.ts:110-420 (devolvíveis, abatimento sem baixa fingida, crédito com nota paga e parcialmente vendida, limites, cancelamento pelo carimbo, sem_financeiro só sem dívida, recusas, estorno bloqueado, gancho fiscal, permissões e isolamento). src/pages/gs/__tests__/devolucaoAoFornecedor.test.tsx:136-195. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/SupplierReturnService.ts:279-569 (registrarDevolucao: estoque, 3 modos financeiros, limites), :634-644 (pendência fiscal), :720-785 (registrarSituacaoFiscal com chave válida); server/src/services/core/NfeImportService.ts:2624-2634 (estorno recusa com CORE_NOTE_HAS_SUPPLIER_RETURN); server/src/routes/v1/core.ts:12838-12910, :12963-12990 (leitura gerentes+estoquista, escrita gerência, auditoria); src/router/gsRoutes.tsx:494-499; src/pages/gs/EntradaNotasPage.tsx:2148 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | A NF-e de devolução sai pelo emissor do contador, e a chave dela é registrada no gancho. Observação: o emissor do sistema só gera finNFe=1 (FiscalXmlNfe.ts:436). A ficha pedia só o gancho, e o gancho existe; a emissão própria é do domínio FIS. |

### GAP-PRD-090 — "Enviar ao fornecedor" só muda o status do pedido — nada é enviado e não existe documento imprimível do pedido de compra

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / EST |
| ANTES | 'Enviar ao fornecedor' só fazia UPDATE status='enviado'. Não existia documento imprimível nem e-mail. |
| Causa | o gesto de enviar nunca produziu documento nem mensagem; o rotulo prometia um envio que nao acontecia |
| Correção | PurchaseOrderDocument: renderPurchaseOrderA4 (comprador, fornecedor, itens, custos, total, previsao, prazo de pagamento, observacao, texto escapado, tarja RASCUNHO/CANCELADO) e enviarPedidoPorEmail (fila de e-mail com o A4 anexado no cofre, template novo pedido_compra via queuePedidoCompraEmail, rascunho enviado por e-mail vira enviado na mesma transacao, sem SMTP responde READY_FOR_CREDENTIAL, repetir com pendente nao duplica, fornecedor sem e-mail e recusa com o caminho, to opcional); rotas GET /purchase-orders/:id/impressao (gerentes+estoquista) e POST /purchase-orders/:id/email (gerentes) com trilha; tela: Imprimir pedido, Enviar por e-mail ao fornecedor e Marcar como enviado (so gerencia), frases honestas; EmailsPage rotula o template |
| DEPOIS | Existem o A4 do pedido (GET /purchase-orders/:id/impressao) e o envio por e-mail com o A4 anexado (POST /purchase-orders/:id/email). Sem SMTP a mensagem fica na fila e a resposta diz READY_FOR_CREDENTIAL. A tela oferece Imprimir pedido, Enviar por e-mail e Marcar como enviado, com frases honestas. |
| Arquivos | server/src/services/core/PurchaseOrderDocument.ts, server/src/services/notifications/EmailService.ts, server/src/routes/v1/core.ts, server/tests/pedido-de-compra-vai-ao-fornecedor.test.ts, src/lib/api/pedidoDeCompra.ts, src/pages/gs/PedidosCompraPage.tsx, src/pages/gs/EmailsPage.tsx, src/pages/gs/__tests__/pedidoCompraSaiDoSistema.test.tsx |
| COMMIT | 7979917 |
| TESTES | server/tests/pedido-de-compra-vai-ao-fornecedor.test.ts:141-280 (A4 com itens/custos/total/tarja, permissões e empresa, fila sem SMTP com anexo, sem duplicar, entrega com SMTP simulado, fornecedor sem e-mail recusa, cancelado recusa). src/pages/gs/__tests__/pedidoCompraSaiDoSistema.test.tsx:116-170. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/PurchaseOrderDocument.ts:158 (renderPurchaseOrderA4), :314-380 (enviarPedidoPorEmail, queuePedidoCompraEmail); server/src/routes/v1/core.ts:14816-14857 (perfis, auditoria purchase_orders.emailed); server/src/services/notifications/EmailService.ts:954-976; server/src/config/env.ts:273-275; src/pages/gs/PedidosCompraPage.tsx:776-787 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Para a entrega real do e-mail: credenciais SMTP do servidor (EMAIL_ENABLED, EMAIL_FROM, EMAIL_SMTP_HOST/USER/PASSWORD). Imprimir funciona sem nada. |

### GAP-PRD-091 — Segundo evento de confirmação (PAYMENT_CONFIRMED + PAYMENT_RECEIVED, ids distintos) grava 'baixa recusada' na cobrança de título já paga

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | Todas / FIN |
| ANTES | Um PAYMENT_RECEIVED depois do PAYMENT_CONFIRMED (ids distintos) chamava settleEntry de novo. A recusa gravava 'baixa recusada' no last_error de uma cobrança já paga. |
| Causa | a baixa do titulo nao era idempotente por cobranca; o id de fallback do evento era o da cobranca; amount_mismatch/paid_after_cancel sem posto na regua |
| Correção | aplicarEventoNaCobranca (efeito extraido do webhook): antes de settleEntry confere baixa com nota 'Asaas <provider_ref>' ja existente e responde 'ja baixado' sem last_error; confirmed_at preservado (COALESCE); segunda confirmacao sobre amount_mismatch/paid_after_cancel nao reaplica; RANK_POR_STATUS com amount_mismatch=3 e paid_after_cancel=3; evento sem id identificado por tipo:cobranca; efeito inteiro numa transacao (intencao so vira confirmed junto com a baixa/pagamento) |
| DEPOIS | Antes de settleEntry, o sistema confere se já existe baixa com nota 'Asaas <provider_ref>'. Se existe, responde 'já baixado' sem last_error. confirmed_at fica o da primeira confirmação (COALESCE). Segunda confirmação sobre amount_mismatch/paid_after_cancel não reaplica, e o efeito roda numa transação. O alerta verdadeiro (título baixado à mão) continua. |
| Arquivos | server/src/services/core/PaymentService.ts, server/tests/webhook-confirmacao-repetida.test.ts |
| COMMIT | 3161eba |
| TESTES | server/tests/webhook-confirmacao-repetida.test.ts (7 casos): CONFIRMED e depois RECEIVED → o detail não contém 'NÃO baixado', last_error nulo, confirmed_at preservado, 1 baixa, listPaymentIntents com lastError nulo; a ordem inversa também; baixa manual anterior continua acusando; pedido com 1 só evento 'pago'; evento sem id; amount_mismatch/paid_after_cancel não regridem. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/PaymentService.ts:958-969 (tituloJaBaixadoPorEstaCobranca), 1211-1213, 1087-1092, 1094-1102, 894-905, 1510-1514, 1559 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-092 — Estorno (refund) de cobrança de título não existe no ERP — só do pedido online

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / FIN |
| ANTES | refundPayment só era chamado pelo pedido online. Não havia rota nem botão para estornar a cobrança paga de um título, e a baixa ficava de pé. |
| Causa | o estorno de cobranca so existia para o pedido online; o titulo dependia do portal do Asaas e de lembrar de estornar a baixa a mao |
| Correção | FinanceChargeRefund.refundFinanceEntryCharge: estorna no Asaas da operacao a cobranca paga (confirmed/amount_mismatch/paid_after_cancel) e, com desfazerBaixa explicito, estorna a baixa 'Asaas <ref>' por reverseSettlement (original marcada, contrapartida com motivo); ja estornada no portal -> so reverte a baixa; recusa do provedor 422 com a frase dele (nada muda, last_error), falha de rede 502 'resultado incerto'. Rota POST /core/finance/entries/:id/charges/refund (gerencia; 400 sem desfazerBaixa booleano; auditoria finance.charge_refunded). listPaymentIntents ganha settlementStanding. Webhook PAYMENT_REFUNDED de titulo diz onde desfazer a baixa ou que ja foi desfeita. ContasPage: 'Estornar cobranca'/'Desfazer a baixa' com confirmacao e motivo, so para a gerencia. |
| DEPOIS | POST /core/finance/entries/:id/charges/refund é só da gerência, pega o companyId do token, exige desfazerBaixa booleano (400 sem ele) e audita finance.charge_refunded. Ele estorna no Asaas da operação e, se confirmado, desfaz a baixa 'Asaas <ref>' por reverseSettlement com motivo. Se já foi estornado no portal, só desfaz a baixa. Recusa do provedor dá 422 com a frase dele; falha de rede dá 502. A ContasPage tem 'Estornar cobrança'/'Desfazer a baixa' com confirmação, só para a gerência. |
| Arquivos | server/src/services/core/FinanceChargeRefund.ts, server/src/services/core/PaymentService.ts, server/src/routes/v1/core.ts, src/pages/gs/ContasPage.tsx, src/lib/api/cobrancas.ts, src/lib/api/core.ts, server/tests/estorno-da-cobranca-do-titulo.test.ts, server/tests/helpers/asaasComEstado.ts, src/pages/gs/__tests__/estornoDaCobranca.test.tsx |
| COMMIT | 474ebd7 |
| TESTES | server/tests/estorno-da-cobranca-do-titulo.test.ts (10 casos): estorna e desfaz a baixa com contrapartida, e a conciliação fica limpa; sem desfazer, a baixa fica; estorno no portal → o gesto só desfaz; um PAYMENT_REFUNDED posterior não desfaz duas vezes; recusa do provedor não muda nada; título sem cobrança paga → 409; outra operação → 404; rota 200 com auditoria; 400 sem desfazerBaixa; 403 para o caixa. src/pages/gs/__tests__/estornoDaCobranca.test.tsx (6 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/FinanceChargeRefund.ts:110-222; server/src/routes/v1/core.ts:6600-6640; server/src/services/core/PaymentService.ts:1251-1274 (o webhook diz onde desfazer); src/pages/gs/ContasPage.tsx:1113-1158; src/lib/api/cobrancas.ts:64 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-093 — Rotas legadas /api/v1/asaas/* respondem placeholder com cara de real e leem só o .env

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas (alcançáveis por gerente_loja, gestor, admin) / FIN |
| ANTES | /asaas/charges/:id respondia status 'queued' fixo; homologation/start e production/activate eram placeholders; /asaas/status lia só o .env; /asaas/charges enfileirava numa coleção paralela. Tudo isso estava anunciado no OpenAPI. |
| Causa | rotas de um Asaas paralelo ao do nucleo ficaram no contrato publico respondendo placeholder |
| Correção | As rotas que fingiam (/asaas/charges, /asaas/charges/:id, /asaas/charges/:id/cancel, /asaas/customers/sync, /asaas/homologation/start, /asaas/production/activate) respondem 410 API_ROUTE_GONE com details.substituta (a rota do nucleo que faz o servico), mantendo autenticacao e permissao; /asaas/status le o cofre da operacao (getAsaasCredentialStatus, sem expor chave, companyId do token); OpenAPI deixa de anunciar /asaas/charges e passa a anunciar /core/finance/entries/{id}/charge e /core/payment-intents. |
| DEPOIS | customers/sync, charges (POST e GET :id), charges/:id/cancel, homologation/start e production/activate respondem 410 API_ROUTE_GONE com details.substituta, mantendo autenticação e permissão. /asaas/status lê o cofre da operação do token, sem expor a chave. O OpenAPI não anuncia mais /asaas/charges e anuncia as rotas do núcleo. |
| Arquivos | server/src/routes/v1/index.ts, server/src/openapi/spec.ts, server/tests/asaas-rotas-legadas.test.ts, server/tests/api.test.ts |
| COMMIT | 32caf1f |
| TESTES | server/tests/asaas-rotas-legadas.test.ts (describe GAP-PRD-093): cada rota que saiu → 410 com a substituta; sem sessão continua 401; /asaas/status lê o cofre; uma operação não enxerga a chave de outra; o OpenAPI não anuncia as que saíram. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/index.ts:228-235 (saiuDoContrato 410), 237-254 (status pelo cofre), 275-315, 407-431; server/src/openapi/spec.ts:150-171 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-094 — Fluxo de caixa (projeção de entradas/saídas e saldo projetado) não existe

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / FIN |
| ANTES | Não existia fluxo de caixa: nenhuma rota, serviço, tela ou teste de projeção. |
| Causa | Ausencia: o financeiro sabia saldo de hoje (accountBalanceCents), abertos (summarize) e faixas de atraso, mas nada juntava os tres por vencimento. |
| Correção | Servico FluxoDeCaixa.projetarFluxoDeCaixa: saldo de hoje das contas por accountBalanceCents; saldo em aberto de cada titulo vivo por vencimento; dia ate 31 dias, semana acima; 30/60/90 ate 366 dias; saldo projetado por periodo, menor saldo e primeiro dia negativo; vencidos por escolha explicita payables (padrao conservador) / both / none; ressalvas do que fica fora (sem vencimento, depois do horizonte, dinheiro quitado sem conta, titulos sem conta no filtro por conta); conta de outra operacao 404. Rota GET /core/finance/cash-flow (gerencia). Tela Financeiro > Fluxo de caixa (menu, rota, horizonte, conta, agrupamento, vencidos, alerta do primeiro dia negativo, periodo abre os titulos com link para a origem, ressalvas); cliente com contrato conferido. |
| DEPOIS | GET /core/finance/cash-flow (gerência, companyId do token) projeta a partir do saldo de hoje das contas (accountBalanceCents). Soma o saldo em aberto dos títulos vivos por vencimento, por dia até 31 dias e por semana acima, com horizonte de até 366 dias. Dá o saldo projetado, o menor saldo e o primeiro dia negativo, trata vencidos em modo explícito e lista ressalvas. Conta de outra operação dá 404. A tela Financeiro > Fluxo de caixa está no menu e na rota. |
| Arquivos | server/src/services/core/FluxoDeCaixa.ts, server/src/routes/v1/core.ts, src/pages/gs/FluxoDeCaixaPage.tsx, src/lib/api/fluxoDeCaixa.ts, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, server/tests/fluxo-de-caixa-projetado.test.ts, src/pages/gs/__tests__/fluxoDeCaixa.test.tsx, server/tests/o-menu-nao-promete-o-que-o-servidor-nega.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/router/__tests__/environments.test.tsx |
| COMMIT | fd7f922 |
| TESTES | server/tests/fluxo-de-caixa-projetado.test.ts (10 casos): 30 dias por dia a partir do saldo de hoje; soma o saldo em aberto e deixa o cancelado fora; primeiro dia negativo; vencidos em modo payables; 60/90 dias viram semanas; ressalvas; filtro por conta; conta de outra operação 404; caixa 403; entrada inválida 400. src/pages/gs/__tests__/fluxoDeCaixa.test.tsx (5 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/FluxoDeCaixa.ts:133-430 (211-230 saldo inicial e 404 da conta, 255-266 títulos abertos da operação, 346-367 saldo e primeiro negativo); server/src/routes/v1/core.ts:6431-6450; src/components/gs/navItems.ts:509; src/router/gsRoutes.tsx:417-418 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-095 — Assistente de prontidão cego ao grupo tributário: checklist e painel do PDV dizem 'pode emitir' e toda venda falha no clique (estado real do banco: SIMPLES-101 sem pCredSN, sem CST PIS/COFINS)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / PARTIAL_IMPLEMENTATION (após refutação: P2 / PARTIAL_IMPLEMENTATION) |
| Empresa / frente | Todas as seis (Preço Justo hoje) / FIS |
| ANTES | O checklist e o painel do PDV diziam 'pode emitir' com o grupo SIMPLES-101 sem pCredSN e sem CST de PIS/COFINS. A venda só falhava no clique. |
| Causa | A regua da tributacao so existia na forma que recusa na primeira falta (TributacaoDoItem), chamada no clique; o checklist e o painel do PDV nao a executavam. |
| Correção | TributacaoDoItem passa a ter uma regua so (avaliar) com dois juizes: o que recusa (emissao, mesma frase de sempre) e o que anota todas as faltas (diagnosticarTributacao), separando falta de tributacao do grupo de falta de classificacao do produto (CFOP/origem, ja cobertas pelos itens de catalogo). ProntidaoTributaria: item product_tax_group do checklist (dono contador, contagem de produtos cuja tributacao fecha, lista por grupo de TODAS as faltas, grupos quebrados sem produto como PENDING, operacao sem grupo nem produto como PENDING com o aviso), agrupando o catalogo por perfil (uma avaliacao por perfil, custo nao cresce com o catalogo); motivosDaTributacaoDaVenda alimenta emissionReadinessForSale (painel do PDV) e orderInvoiceReadiness (NF-e do pedido) antes do clique. product_origin e product_tax_group entram nas chaves de catalogo (nao escondem o botao de uma venda completa; a venda e conferida item a item). O pdv-summary trata a pendencia como PENDING de catalogo (chave product_*). Tela: o checklist mostra o item com o atalho "Abrir Catalogo > Grupos tributarios" (?aba=tributarios, que a tela de Auxiliares passou a aceitar). |
| DEPOIS | buildReadiness ganhou o item product_tax_group (dono contador), que roda diagnosticarTributacao por perfil e lista todas as faltas por grupo. emissionReadinessForSale e orderInvoiceReadiness juntam os motivos da tributação da venda antes do clique. A tela tem atalho para Catálogo › Grupos tributários (?aba=tributarios), e a tela de Auxiliares aceita a aba. |
| Arquivos | server/src/services/core/ProntidaoTributaria.ts, server/src/services/core/TributacaoDoItem.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/core/FiscalPipelineService.ts, server/src/services/core/OrderInvoiceService.ts, server/tests/prontidao-enxerga-o-grupo-tributario.test.ts, src/pages/gs/FiscalPage.tsx, src/pages/gs/AuxiliaresCatalogoPage.tsx, src/pages/gs/__tests__/fiscalCrtEProntidaoTributaria.test.tsx, src/pages/gs/__tests__/auxiliaresIcmsDoGrupo.test.tsx |
| COMMIT | bdeaa93, a0d4556 |
| TESTES | server/tests/prontidao-enxerga-o-grupo-tributario.test.ts (16 casos): o checklist deixa de dizer 'pode emitir' e nomeia a falta; o painel recebe o motivo antes do clique e o número não anda; a lista vem inteira; pdv-summary nomeia a pendência. Rodei: verde. Tela: src/pages/gs/__tests__/fiscalCrtEProntidaoTributaria.test.tsx, rodei: verde. |
| EVIDÊNCIA | server/src/services/core/ProntidaoTributaria.ts:78-185 (item product_tax_group, FAIL/PENDING, owner contador) e :194-221 (motivos da venda); FiscalPipelineService.ts:622-640; OrderInvoiceService.ts:313-325; FiscalConfigService.ts:44 e :988+; src/pages/gs/FiscalPage.tsx:965-969; src/pages/gs/AuxiliaresCatalogoPage.tsx:72-77. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Contador: pCredSN do CSOSN 101 e CST de PIS/COFINS do SIMPLES-101 da Preço Justo, e o grupo inteiro das outras cinco. A gerência grava em Catálogo › Grupos tributários. Não é código. |

### GAP-PRD-096 — Rotas legadas /api/v1/fiscal/nfe: validate/number/xml/sign alteram documento de OUTRA empresa pelo id e fabricam chave '3526<timestamp>'; /api/v1/fiscal health/reconciliation e nfe xml respondem valores cravados

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | Todas as seis / FIS |
| ANTES | As rotas legadas /api/v1/fiscal/nfe (validate, number, xml, sign) alteravam documento de outra empresa pelo id e fabricavam a chave '3526<timestamp>'. health, reconciliation e o hash do xml respondiam valores cravados. |
| Causa | Camada JSON legada (nfe_documents/nfce_documents) de uma emissao que nunca existiu, ainda montada em v1Router, com rotas que alteravam documento pelo id sozinho e respostas cravadas. |
| Correção | routes/v1/fiscal.ts e routes/v1/nfe.ts apagados e desmontados de v1/index.ts; routes/v1/nfce.ts reduzido ao CSC (GET/POST /fiscal/nfce/csc, que a tela usa e que grava onde a NFC-e do nucleo le); updateNfeDocumentBackend e updateNfceDocumentBackend (filtro so pelo id) apagados dos servicos legados; o OpenAPI so anuncia /fiscal/nfce/csc. Os servicos legados ficam (testes de homologacao os importam), sem nenhuma rota de escrita. |
| DEPOIS | routes/v1/fiscal.ts, nfe.ts e nfce.ts não existem mais, e v1/index.ts não monta nenhum prefixo /fiscal. O CSC foi para /core/fiscal/nfce/csc, com a empresa do token. updateNfeDocumentBackend e a chave '3526' não existem no código. |
| Arquivos | server/src/routes/v1/index.ts, server/src/routes/v1/nfce.ts, server/src/routes/v1/fiscal.ts (apagado), server/src/routes/v1/nfe.ts (apagado), server/src/services/nfe/NfeService.ts, server/src/services/nfce/NfceService.ts, server/src/openapi/spec.ts, server/tests/rotas-fiscais-legadas-fora-do-ar.test.ts, server/tests/fiscal.test.ts, server/tests/nfe.test.ts, server/tests/nfce.test.ts, server/tests/audit-fiscal.test.ts, server/tests/session-switch.test.ts, server/tests/a-unidade-fiscal-e-uma-so.test.ts, server/tests/permissions.test.ts |
| COMMIT | 1d2efea |
| TESTES | server/tests/rotas-fiscais-legadas-fora-do-ar.test.ts: serviços legados e roteador ausentes; toda rota legada responde 404; o POST na porta velha do CSC não grava; as sondas públicas saíram; o CSC do núcleo serve a empresa do token; o OpenAPI não lista /fiscal. Rodei: verde. |
| EVIDÊNCIA | server/src/routes/v1/index.ts:89-104 (comentário da remoção; só logistics, payment-terminals, system, auth, core e loja montados); server/src/routes/v1/ (sem fiscal.ts, nfe.ts nem nfce.ts); a busca por updateNfeDocumentBackend e por 3526 em server/src só acha o comentário; core.ts:4473-4518 (CSC no núcleo, companyId de scope(req)). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-097 — Sem XSD: validateAgainstSchema só confere boa formação — a conformidade com o layout é julgada apenas pela SEFAZ

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas as seis / FIS |
| ANTES | validateAgainstSchema só conferia a boa formação e devolvia validated:false sempre. A conformidade com o leiaute só era julgada pela SEFAZ, depois de o número ser queimado. |
| Causa | Nenhum pacote de esquemas nem validador XSD; a conformidade de leiaute era julgada so pela SEFAZ, com o numero ja reservado. |
| Correção | XSDs do pacote PL_010b_V1.30 (nfe, enviNFe, procNFe, inutNFe, leiauteNFe, leiauteInutNFe, tiposBasico_v4.00, DFeTiposBasicos, xmldsig-core-schema_v1.01) em server/fiscal-schemas com MANIFESTO.json (SHA-256 normalizado em LF; origem node-sped-nfe@1.2.52 conferida arquivo a arquivo contra node-nfe-nfce@1.0.120); FiscalXsdValidator sobre libxml2-wasm 0.7.2 (pacote ausente ou adulterado = indisponivel, nunca validated:true); nota nao assinada validada com assinatura-molde; validateAgainstSchema delega ao XSD; portao conferirLeiauteAntesDeNumerar (numero provisorio) em createNfceForSale, createNfeForSale e OrderInvoiceService — 409 CORE_FISCAL_LAYOUT_INVALID nomeando o campo, 503 CORE_FISCAL_XSD_UNAVAILABLE sem pacote, e a serie nao anda; DRAFT->VALIDATED usa o XSD e vai para ERROR com o motivo; CEP do emitente exigido em validateNfce/validateNfe e na prontidao (item Endereco); cIdToken sem zeros a esquerda no QR v2; a tela de documentos rotula motivo sem cStat como recusa da conferencia local, e nao como retorno da SEFAZ. |
| DEPOIS | Os XSDs PL_010b_V1.30 estão embutidos com MANIFESTO.json, e o FiscalXsdValidator usa libxml2. conferirLeiauteAntesDeNumerar valida com número provisório antes de reservar o número em createNfceForSale, createNfeForSale e OrderInvoiceService: leiaute errado dá 409 e pacote ausente dá 503. DRAFT→VALIDATED exige o XSD; sem ele, o documento vai para ERROR. |
| Arquivos | server/fiscal-schemas/PL_010b_V1.30/*, server/src/services/core/FiscalXsdValidator.ts, server/src/services/core/FiscalXmlForma.ts, server/src/services/core/FiscalXmlNfce.ts, server/src/services/core/FiscalXmlNfe.ts, server/src/services/core/FiscalDocumentService.ts, server/src/services/core/OrderInvoiceService.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/nfce/NfceCscService.ts, src/pages/gs/FiscalDocumentosPage.tsx, server/tests/fiscal-leiaute-xsd.test.ts, server/tests/fiscal-leiaute-sem-pacote.test.ts, src/pages/gs/__tests__/FiscalDocumentosMotivoLocal.test.tsx, fixtures de 19 testes fiscais do servidor com CEP do emitente |
| COMMIT | 5451630 |
| TESTES | server/tests/fiscal-leiaute-xsd.test.ts (13): manifesto confere o SHA-256; NFC-e e NF-e montadas passam; xProd de 130 caracteres é recusado e o número não é reservado; XML fora do leiaute vai para ERROR. server/tests/fiscal-leiaute-sem-pacote.test.ts (5): sem pacote dá 503 antes do número, e XSD adulterado derruba o pacote. Rodei os dois: verde. Tela: FiscalDocumentosMotivoLocal.test.tsx, verde. |
| EVIDÊNCIA | server/fiscal-schemas/PL_010b_V1.30/* (9 XSD + MANIFESTO.json); server/src/services/core/FiscalXsdValidator.ts:188-228 e :284-309; FiscalDocumentService.ts:357-369 (portão antes de reserveNextNumber) e :528; OrderInvoiceService.ts:417; FiscalDocumentService.ts:666-693 (ERROR ou VALIDATED com schemaPackage). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-098 — Contingência é só fundação: tpEmis não muda, sem DANFCE/dizeres de contingência, sem EPEC, entra após 5 tentativas (só se houver emissões) e sai só por rota sem botão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas as seis / FIS |
| ANTES | A contingência era só fundação. tpEmis não mudava, não havia DANFCE de contingência, só entrava após 5 tentativas e só saía por rota sem botão. |
| Causa | A contingencia existia so como estado do documento, sem a regra (modalidade, prazo), sem montagem off-line, sem QR/DANFCE de contingencia e sem caminho de volta - decisao externa sem mecanismo no software. |
| Correção | FiscalContingenciaOffline: politica por empresa (core_fiscal_contingency_policies; AGUARDAR = padrao seguro; OFFLINE_NFCE exige prazo inteiro 1..168 h; so os donos gravam, com auditoria fiscal.contingency_policy_updated; desligar encerra o periodo) e periodo por empresa (core_fiscal_contingency_periods, indice unico parcial de um aberto; abre sozinho na indisponibilidade CONFIRMADA de uma NFC-e - 108/109/999 ou rede fora com a consulta tambem sem resposta; ou pela gerencia com justificativa 15..256 saneada para o TString do xJust; fecha sozinho pela sondagem 107 do trabalhador ou por qualquer resposta conclusiva, ou pela gerencia). createNfceForSale monta com tpEmis 9 DESDE O INICIO durante o periodo (chave, <tpEmis>, <dhCont> no fuso da UF, <xJust>), conferido pelo XSD antes de numerar com QR provisorio; NfceQrOffline monta o QR V2 OFFLINE (dia do dhEmi, vNF, digVal = hex do DigestValue, cIdToken sem zeros, hash SHA-1 com o CSC) e a assinatura o troca pelo definitivo fora do infNFe (assinatura e XSD reconferidos). A nota off-line vai para CONTINGENCY sem transmitir no balcao; o trabalhador pausa a NFC-e durante o periodo, transmite ao fechar, e a nota off-line nunca vira dead (espera maxima 15 min); cada autorizada encerra a propria contingencia (registro preservado). A nota tpEmis 1 que disparou o periodo continua a mesma, na fila (sem segunda nota para a venda). DanfceRenderer: nota off-line sai sem previa com "EMITIDA EM CONTINGENCIA" e "Pendente de autorizacao" (so a primeira depois de autorizada); o QR do DANFCE passa a ser o do XML assinado. Pendencias: "transmitir ate..." e CONTINGENCY_OVERDUE fora do prazo. Prontidao: item "Contingencia da NFC-e" (PENDING, dono contador, nao bloqueia). A nota antiga que desistiu por indisponibilidade volta sozinha na sondagem 107. SefazTestAdapter: consulta com cenario NETWORK_ERROR/TIMEOUT falha como a rede (para o ensaio da indisponibilidade confirmada). Rotas GET /fiscal/contingency, PUT /fiscal/contingency/policy (donos), POST /fiscal/contingency/enter e /exit (gerencia); pdv-summary traz a contingencia aberta. Tela: quadro "Contingencia da NFC-e" (modalidade, prazo, observacao, periodo com a ultima sondagem, entrar/encerrar, notas off-line e prazo mais proximo), "DANFCE de contingencia" na lista e no PDV (com a instrucao ao caixa e o prazo; o poll para), selo EM CONTINGENCIA no balcao. |
| DEPOIS | As duas modalidades existem: AGUARDAR (padrão) e OFFLINE_NFCE com prazo de 1 a 168 h. Só os donos gravam, com trilha. Com período aberto, a NFC-e nasce com tpEmis 9, dhCont, xJust e QR offline, conferida pelo XSD antes do número. O DANFCE sai com 'EMITIDA EM CONTINGÊNCIA / Pendente de autorização', e o período fecha sozinho pela sondagem 107 ou pela gerência na tela. A escolha é só configuração. |
| Arquivos | server/src/services/core/FiscalContingenciaOffline.ts, server/src/services/core/NfceQrOffline.ts, server/src/db/schema.ts, server/src/services/core/FiscalDocumentService.ts, server/src/services/core/FiscalXmlNfce.ts, server/src/services/core/FiscalPipelineService.ts, server/src/services/core/FiscalQueueService.ts, server/src/services/core/FiscalQueueWorker.ts, server/src/services/core/FiscalContingencyService.ts, server/src/services/core/DanfceRenderer.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/core/SefazTestAdapter.ts, server/src/routes/v1/core.ts, server/tests/fiscal-contingencia-offline.test.ts, server/tests/fiscal-contingency.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/contingenciaFiscal.ts, src/components/gs/ContingenciaFiscal.tsx, src/pages/gs/FiscalDocumentosPage.tsx, src/components/gs/PainelFiscalPdv.tsx, src/components/gs/FiscalBadgePdv.tsx, src/lib/api/core.ts, src/components/gs/__tests__/contingenciaFiscalNaTela.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | d7a3a13 |
| TESTES | server/tests/fiscal-contingencia-offline.test.ts (19): padrão AGUARDAR; o gerente leva 403 e o dono grava com trilha; o estado declarado deixou de ser fundação; 108 abre o período; a NFC-e do período sai com tpEmis 9, dhCont, xJust e QR offline conferido; DANFCE com os dizeres; a sondagem 107 fecha e transmite; a nota offline nunca desiste; CONTINGENCY_OVERDUE. Rodei: verde. Tela: contingenciaFiscalNaTela.test.tsx, verde. |
| EVIDÊNCIA | server/src/services/core/FiscalContingenciaOffline.ts:48-53, :92 (gravarPoliticaDeContingencia), :267 (abrirPeriodo), :366 (encerrarPeriodo), :439-455 (emissaoEmContingencia tpEmis 9); FiscalDocumentService.ts:346-360; DanfceRenderer.ts:117-157; FiscalContingencyService.ts:57 (não é mais FOUNDATION); core.ts:8190-8240 (GET, PUT policy só donos via requireProfile(req), enter e exit); src/components/gs/ContingenciaFiscal.tsx montado em FiscalDocumentosPage.tsx:208; src/lib/api/contingenciaFiscal.ts:58-70. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Contador ou Emanuel: escolher AGUARDAR ou OFFLINE_NFCE e o prazo da UF em Fiscal > Documentos > Contingência da NFC-e. Depois, homologar na SVRS uma NFC-e offline com o A1 real. EPEC não foi feito (no RS a NFC-e usa a offline). Contingência SVC da NF-e 55 seria trabalho novo, fora desta ficha. |

### GAP-PRD-099 — Rotas de abrir OS e cadastrar equipamento nomeiam caixa e atendente, mas resolveWorkshop recusa quem não é membro da bancada

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / BUG (após refutação: P2 / BUG) |
| Empresa / frente | Oficina, Preço Justo (celulares) / OFI |
| ANTES | POST /workshop/orders e POST /equipment nomeavam caixa e atendente, mas resolveWorkshop só alcançava bancadas de membros. Esses perfis levavam sempre 400 CORE_WORKSHOP_REQUIRED ou 403. |
| Causa | as duas rotas de ENTRADA usavam a regua de quem conserta (filiacao a bancada); o balcao da oficina nao e membro de bancada, e o caixa mora no ambiente pdv sem tela de abertura |
| Correção | WorkshopIntakeService (bancadasDeEntrada/bancadaDeEntrada): gestao (admin_geral/gestor/gerente_oficina) e balcao (atendente/operador_caixa_oficina) alcancam toda bancada ativa da empresa, mecanico so as da filiacao; unica bancada assumida; varias -> 400 CORE_WORKSHOP_REQUIRED com a lista; bancada fora do alcance (inclusive de outra empresa) -> 403 CORE_WORKSHOP_FORBIDDEN; mecanico sem vinculo -> 403 com o caminho (vincular em Oficinas); empresa sem oficina -> 404. POST /workshop/orders e POST /equipment usam resolveBancadaDeEntrada; GET /workshop/entrada lista as bancadas de entrada. Telas: botao "Abrir OS" no PDV (caixa/gerente da oficina, so com temOficina) com AbrirOsDialog (cliente do cadastro ou digitado, aparelho, placa/gaveta, defeito, prioridade); CampoBancada no Nova OS do quadro (OficinaPage) e no cadastro de equipamento (EquipamentosPage) quando ha mais de uma bancada; auditoria workshop.order.create/equipment.create inalteradas |
| DEPOIS | resolveBancadaDeEntrada usa WorkshopIntakeService. Gestão e balcão (atendente/operador_caixa_oficina) alcançam toda bancada ativa da empresa do token; mecânico só as da sua filiação. Com uma bancada ela é assumida, com várias a escolha é pedida, e bancada de outra empresa dá 403. GET /workshop/entrada lista as bancadas, e o PDV tem o botão 'Abrir OS'. |
| Arquivos | server/src/services/core/WorkshopIntakeService.ts, server/src/routes/v1/core.ts, src/lib/api/oficinaEntrada.ts, src/hooks/useBancadasDeEntrada.ts, src/components/gs/BancadaDeEntrada.tsx, src/components/gs/AbrirOsDialog.tsx, src/pages/gs/PdvPage.tsx, src/pages/gs/OficinaPage.tsx, src/pages/gs/EquipamentosPage.tsx, src/lib/api/core.ts, server/tests/quem-mexe-na-os.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/quemMexeNaOs.test.tsx |
| COMMIT | c699bcf |
| TESTES | server/tests/quem-mexe-na-os.test.ts bloco GAP-PRD-099 (6): caixa abre OS na única bancada, com auditoria; atendente cadastra equipamento e abre OS; caixa cadastra equipamento; duas bancadas pedem escolha, bancada de outra empresa dá 403 e /workshop/entrada lista A e B; mecânico preso à filiação e mecânico solto 403; gerente_loja 403. src/pages/gs/__tests__/quemMexeNaOs.test.tsx bloco GAP-PRD-099 (5). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/WorkshopIntakeService.ts:62-119; server/src/routes/v1/core.ts:7279-7284, 9473-9481, 9483-9519 (auditoria workshop.order.create), 10289-10295; src/pages/gs/PdvPage.tsx:2924-2928 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-100 — Eventos de domínio da OS: só 'service_order.opened' é emitido; 'status_changed' está no catálogo e no projetor mas ninguém o dispara

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | Só 'service_order.opened' era emitido. O consolidado via toda OS em_aberto e com total zero. |
| Causa | o evento existia no catalogo e no projetor e nenhuma porta que muda a situacao da OS o emitia |
| Correção | registrarSituacaoNaCentral (WorkshopCoreService) emite service_order.status_changed com a OS inteira, operation update e a bancada como unidade operacional, dentro da transacao, em assumeOrder, moveOrder, releaseOrder, completeTechnical (com e sem custo) e settleOrder; WorkshopOrderReopen emite o mesmo retrato no estorno (sem importar servico). Movimento recusado nao deixa evento (rollback) |
| DEPOIS | registrarSituacaoNaCentral emite 'service_order.status_changed' com a OS inteira, dentro da transação, em assumeOrder, moveOrder, releaseOrder, completeTechnical e settleOrder. O estorno (WorkshopOrderReopen) emite o mesmo retrato. |
| Arquivos | server/src/services/core/WorkshopCoreService.ts, server/src/services/core/WorkshopOrderReopen.ts, server/tests/os-na-central-e-no-cmv.test.ts |
| COMMIT | c699bcf |
| TESTES | server/tests/os-na-central-e-no-cmv.test.ts bloco GAP-PRD-100 (4): sequência opened + 3 status_changed; projectBatch/InMemoryCentral termina finalizada com total 105000, peças 90000 e mão de obra 15000; mover, largar e estorno aparecem na sequência de status; garantia sai finalizada; movimento recusado não deixa evento. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/WorkshopCoreService.ts:285-299, chamadas em 723 (assume), 840 (move), 923 (release), 1783 (completeTechnical), 1863 (settleOrder); server/src/services/core/WorkshopOrderReopen.ts:100-112 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-101 — Custo da peça consumida na OS não chega ao CMV nem à venda (saída e item da venda nascem com custo nulo)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DATA_INTEGRITY_RISK |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | A saída da peça pela OS nascia com unit_cost_cents NULL e a venda da OS era uma linha só, sem custo. O CMV ignorava toda peça de conserto. |
| Causa | a baixa da peca nao fotografava custo e a venda da OS era uma linha unica de servico; o CMV le so core_sale_items.cost_cents |
| Correção | consumirPromessasDaOs grava o custo do cadastro no momento da baixa (consumeReservation ganhou unitCostCents opcional); custoDaPecaConsumida le o custo da saida no razao; a devolucao depois da baixa volta com o mesmo custo; receberOs consome o que restar ANTES da venda e passa serviceLines a createSale: cada peca na conta (quantidade liquida, preco da OS, custo da baixa) e a mao de obra (custo nulo), todas com product_id nulo e sem movimento; createSale confere a soma (CORE_SERVICE_LINES_MISMATCH) e cai na linha unica quando a OS nao fecha. Custo nao sai para o mecanico (fica no razao, nao na OS) |
| DEPOIS | consumirPromessasDaOs fotografa o custo do cadastro na baixa, e a devolução volta com o mesmo custo. O checkout itemiza a venda por vendaDaOs: cada peça com o custo da baixa e a mão de obra com custo nulo. OS cuja conta não fecha é recusada (409 CORE_ORDER_TOTAL_MISMATCH). |
| Arquivos | server/src/services/core/WorkshopPartsReservation.ts, server/src/services/core/InventoryService.ts, server/src/services/core/WorkshopPartsService.ts, server/src/services/core/WorkshopCashierService.ts, server/src/services/core/SalesService.ts, server/tests/os-na-central-e-no-cmv.test.ts, server/tests/audit-workshop.test.ts, docs/audits/remediacao/migracoes/OFI.md |
| COMMIT | c699bcf |
| TESTES | server/tests/os-na-central-e-no-cmv.test.ts bloco GAP-PRD-101 (6): saída com unit_cost_cents 60000; venda itemizada com cost_cents 60000 mesmo depois de o cadastro mudar; DRE com cogs 120000, receita 180000 e margem 60000; devolução volta com custo 2000; baixa na aprovação leva custo; saída antiga fica nula; conta torta dá 409 sem venda; createSale recusa linhas tortas. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/WorkshopPartsReservation.ts:350-383, 406-425; server/src/services/core/VendaDaOficina.ts:84-109; server/src/services/core/WorkshopCashierService.ts:287-334; server/src/services/core/SalesService.ts:1914-1943; server/src/services/core/WorkshopPartsService.ts:272-274 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-102 — Comentário na OS: a tela oferece a atendente e caixa, o servidor recusa em OS assumida (403 CORE_ORDER_NOT_ASSIGNED_TO_YOU)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | Atendente e caixa caíam em authorKind 'tecnico' e levavam 403 CORE_ORDER_NOT_ASSIGNED_TO_YOU ao comentar em OS assumida. A tela oferecia a caixa de comentário a eles. |
| Causa | atendente e caixa caiam na voz tecnico, que carrega a trava de responsavel |
| Correção | voz 'balcao' (vozNaOs na rota: gestao -> gestor, perfil mecanico -> tecnico, demais -> balcao); addComment aceita 'balcao' sem a trava (so tecnico a tem); author_kind e TEXT sem CHECK. Ficha: titulo 'Anotacao do balcao'; a caixa de comentario nao aparece para o mecanico que nao assumiu (o servidor o recusa) |
| DEPOIS | vozNaOs dá 'gestor' à gestão, 'tecnico' a quem é mecânico e 'balcao' aos demais. addComment só aplica a trava de responsável a 'tecnico'. A ficha esconde a caixa do mecânico que não assumiu e chama a nota de 'Anotação do balcão'. |
| Arquivos | server/src/services/core/WorkshopCoreService.ts, server/src/routes/v1/core.ts, src/pages/gs/OrdemServicoPage.tsx, server/tests/quem-mexe-na-os.test.ts, src/pages/gs/__tests__/quemMexeNaOs.test.tsx |
| COMMIT | c699bcf |
| TESTES | server/tests/quem-mexe-na-os.test.ts bloco GAP-PRD-102 (3): atendente e caixa dão 201 em OS assumida, com author_kind 'balcao'; mec2 dá 403; gerente grava 'gestor'; outra empresa 404. src/pages/gs/__tests__/quemMexeNaOs.test.tsx bloco GAP-PRD-102 (3). Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:7293-7296, 9853-9876; server/src/services/core/WorkshopCoreService.ts:583, 595-602; src/pages/gs/OrdemServicoPage.tsx:313-314, 850, 2065, 2110 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-103 — Devolução de peça não confere responsável nem alcance de bancada, e derruba o total sem derrubar a aprovação do cliente

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | returnPartToStock não conferia responsável nem bancada: qualquer mecânico devolvia peça de OS alheia. O total caía com approved_at de pé. |
| Causa | a devolucao conferia so a empresa e so recalculava o total |
| Correção | returnPartToStock recebe o alcance de bancada (exigirOsNoAlcance -> 404), recusa quem nao assumiu salvo gestao da oficina (403 CORE_ORDER_NOT_ASSIGNED_TO_YOU), e recalcularTotaisDaOS(orderId, {antes, ...}) derruba approved_at/approval_requested_at com comentario quando o total muda; rota passa escopo, nome e papel, auditoria workshop.part_returned com partId, quantidade e motivo. Ficha: Devolver para o gerente em OS de outro tecnico, com a frase certa |
| DEPOIS | A OS é conferida pelo alcance de bancada (404 fora dele). Quem não assumiu leva 403, salvo a gestão. recalcularTotaisDaOS recebe a OS de antes e chama derrubarAprovacaoSeOValorMudou. A rota audita workshop.part_returned e a tela devolve com a mesma régua. |
| Arquivos | server/src/services/core/WorkshopPartsService.ts, server/src/services/core/WorkshopCoreService.ts, server/src/routes/v1/core.ts, src/pages/gs/OrdemServicoPage.tsx, server/tests/quem-mexe-na-os.test.ts, src/pages/gs/__tests__/quemMexeNaOs.test.tsx |
| COMMIT | c699bcf |
| TESTES | server/tests/quem-mexe-na-os.test.ts bloco GAP-PRD-103 (5): não responsável 403 sem efeito; responsável devolve, total vai de 10000 a 5000, approved_at nulo, comentário 'Orçamento alterado' e auditoria; gerente devolve peça de outro técnico; outra bancada e outra empresa 404; sem aprovação não há aviso. src/pages/gs/__tests__/quemMexeNaOs.test.tsx bloco GAP-PRD-103 (2). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/WorkshopPartsService.ts:161-168, 293-300; server/src/services/core/WorkshopCoreService.ts:1315-1331; server/src/routes/v1/core.ts:15686-15717; src/pages/gs/OrdemServicoPage.tsx:844 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-104 — Checkout da OS registra cartão/PIX como liquidado sem maquininha, sem provedor, sem split, sem desconto, sem fiado, sem comprovante

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | O checkout da OS aceitava uma forma, valor cheio, sem desconto, sem maquininha, sem fiado e sem comprovante. Cartão ficava 'settled' por declaração, com provider nulo. |
| Causa | a rota montava a venda na mao em vez de repassar a cesta que createSale ja sabe processar; a tela era um select de um meio |
| Correção | WorkshopCashierService.receberOs repassa a cesta do PDV a createSale (split, troco, providerRef da maquininha conferido por assertCardPaymentBackedByTerminal quando ha maquininha, credito de loja, acrescimo, terminalId do token, desconto com a MESMA alcada do balcao e liberacao do gestor) e faz venda + settleOrder numa transacao; fiado da OS so com core_sale_policies.workshop_credit_enabled=1 (nulo = desligado, caixa na Politica do balcao) e cliente do cadastro (CORE_WORKSHOP_CREDIT_DISABLED / CORE_WORKSHOP_CREDIT_NEEDS_CUSTOMER), vale cobrindo tudo nao conta como fiado; RecebimentoOsDialog (resumo com desconto R$ ou %, PagamentoDialog, AutorizacaoGerenteDialog, botao Faturar so quando o servidor aceita) usado no PDV e na ficha da OS; cupom SALE_RECEIPT imprime "A PRAZO - conta a receber" pelo titulo em aberto; ficha da OS com Imprimir comprovante; auditoria workshop.order.checkout com concessao, liberacao e fiado |
| DEPOIS | receberOs repassa a createSale a cesta do PDV: split, troco, desconto com alçada e liberação, acréscimo, crédito de loja e terminalId do token. Com maquininha configurada, cartão sem providerRef é recusado. Venda e settleOrder saem numa transação só. O fiado exige a política workshop_credit_enabled e cliente do cadastro. RecebimentoOsDialog usa PagamentoDialog e AutorizacaoGerenteDialog. |
| Arquivos | server/src/services/core/WorkshopCashierService.ts, server/src/routes/v1/core.ts, server/src/services/core/SalePolicyService.ts, server/src/db/schema.ts, server/src/services/core/PrintRenderer.ts, src/components/gs/RecebimentoOsDialog.tsx, src/pages/gs/OrdemServicoPage.tsx, src/pages/gs/PoliticaVendaPage.tsx, src/lib/api/core.ts, src/lib/api/oficinaCaixa.ts, server/tests/caixa-da-oficina.test.ts, server/tests/audit-workshop.test.ts, server/tests/politica-do-balcao.test.ts, src/pages/gs/__tests__/caixaDaOficina.test.tsx, src/pages/gs/__tests__/OrdemServicoFechamento.test.tsx, src/pages/gs/__tests__/PoliticaVendaPage.test.tsx, docs/audits/remediacao/migracoes/OFI.md |
| COMMIT | 411f040 |
| TESTES | server/tests/caixa-da-oficina.test.ts bloco GAP-PRD-104 (10): split PIX + dinheiro com troco 2010 e gaveta 17990; desconto na alçada; desconto acima pede CORE_DISCOUNT_NEEDS_AUTHORIZATION e a liberação é gasta na venda; pagar a menos dá CORE_PAYMENT_MISMATCH; maquininha mock recusa cartão sem cobrança (CORE_SALE_TERMINAL_REF_REQUIRED) e grava provider/provider_ref; fiado desligado e ligado; vale; comprovante; chave alheia. src/pages/gs/__tests__/caixaDaOficina.test.tsx bloco GAP-PRD-104 (4). Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:10094-10148; server/src/services/core/WorkshopCashierService.ts:246-268, 277-349; server/src/services/core/SalesService.ts:1319-1351; src/components/gs/RecebimentoOsDialog.tsx:34, 223-240; src/pages/gs/PoliticaVendaPage.tsx:421-427 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional: a maquininha/TEF homologada, com a credencial do provedor, para o cartão da OS exigir a transação aprovada. Sem ela, o cartão é lançado à mão como no PDV da loja. Decisão do dono: ligar 'Faturar OS a prazo' em Política de venda (padrão desligado). Não falta código para nenhum dos dois. |

### GAP-PRD-105 — OS paga não tem caminho de estorno/reabertura; cancelar a venda deixa a OS 'finalizada' apontando para venda cancelada

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | Não havia estorno nem reabertura de OS paga. Cancelar a venda deixava a OS 'finalizada' apontando para venda cancelada, e a correção era por SQL. |
| Causa | a OS paga era so ida: nenhum servico reabria a OS, e o cancelamento da venda nao conhecia a OS que ela pagou |
| Correção | regra padrao (decisao do dono implementada com o padrao seguro): estornar = cancelar a venda da OS pelo MESMO cancelSale e reabrir a OS em aguardando_pagamento (sale_id/paid_at/closed_at nulos, evento finalizada->aguardando_pagamento com motivo e numero da venda); WorkshopOrderReopen.reabrirOsDaVendaCancelada chamado dentro da transacao de cancelSale (vale tambem para POST /sales/:id/cancel); POST /workshop/orders/:id/estorno com motivo obrigatorio, gerente_oficina/donos direto, caixa da oficina com a senha do gestor presa a venda (cancelar_venda via comLiberacaoPontual), recusa de estado antes da senha (CORE_ORDER_NOT_PAID, CORE_ORDER_WITHOUT_SALE), reparo da OS legada finalizada com venda ja cancelada, auditoria workshop.order.reversal com os dois usuarios; a OS reaberta recebe de novo sem colidir chave; se a conta estava errada o gerente move da fila para a bancada (regra existente); EstornoOsDialog na ficha da OS com o aviso de que cartao/PIX precisam ser devolvidos na operadora |
| DEPOIS | cancelSale chama reabrirOsDaVendaCancelada na mesma transação: a OS volta a aguardando_pagamento, com evento, motivo e status_changed. POST /workshop/orders/:id/estorno exige motivo; o gerente faz direto, o caixa com liberação cancelar_venda presa à venda. Há auditoria com os dois usuários, reparo do legado e botão 'Estornar recebimento' na ficha. |
| Arquivos | server/src/services/core/WorkshopOrderReopen.ts, server/src/services/core/SalesService.ts, server/src/services/core/WorkshopCashierService.ts, server/src/routes/v1/core.ts, src/components/gs/EstornoOsDialog.tsx, src/pages/gs/OrdemServicoPage.tsx, server/tests/caixa-da-oficina.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/caixaDaOficina.test.tsx |
| COMMIT | 411f040 |
| TESTES | server/tests/caixa-da-oficina.test.ts bloco GAP-PRD-105 (10): o estorno do gerente cancela venda e título, sangria -20000, evento finalizada->aguardando_pagamento, auditoria e novo recebimento; chave estornada dá CORE_CHECKOUT_REVERSED; sem motivo 400; caixa 403 e depois passa com bilhete; mecânico 403; CORE_ORDER_NOT_PAID e CORE_ORDER_WITHOUT_SALE; cancelar pela tela de vendas reabre; reparo legado; outra empresa 404. src/pages/gs/__tests__/caixaDaOficina.test.tsx bloco GAP-PRD-105 (4). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/SalesService.ts:2672-2677; server/src/services/core/WorkshopOrderReopen.ts:54-133; server/src/services/core/WorkshopCashierService.ts:362-451; server/src/routes/v1/core.ts:10164-10215; src/pages/gs/OrdemServicoPage.tsx:1742-1757, 1781-1791 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Nada obrigatório. A ficha era OWNER_DECISION. A regra implementada (reabrir em aguardando_pagamento) é a própria correção recomendada. Abrir OS nova continua possível pelo fluxo normal. Não existe chave de configuração para a alternativa 'marcar estornada'; se o dono a preferir, isso seria código novo. |

### GAP-PRD-106 — Identidade do equipamento incompleta e sem edição: sem km, sem fotos/anexos, sem placa no cadastro, categoria livre, marca/modelo/chassi/série não editáveis

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Oficina, PJ Motors / INT |
| ANTES | core_equipment não tinha km, placa nem fotos, e a categoria era texto livre. Marca, modelo, chassi e série não eram editáveis: correção só por SQL ou pela unidade de estoque. |
| Causa | a identidade da maquina nao tinha porta de correcao, e placa/km/fotos/tipo nao existiam no equipamento |
| Correção | EquipmentIdentityRules (vocabulario do tipo; placa ABC1234/Mercosul normalizada; km 0..9.999.999; celular sem placa nem km; Outro com marca ou modelo) aplicado no cadastro (createEquipment ganhou plate/odometerKm, placa unica por empresa) e na correcao. EquipmentIdentityService + PATCH /equipment/:id/identidade (mecanico, gerente_oficina): so o que mudou, identidade exige motivo e grava identidade_corrigida com antes -> depois, km novo sem motivo (km_registrado) e km que volta com motivo, chassi/placa de outra plaquinha 409, chassi/motor/serie de maquina vinculada a unidade 409 nomeando a loja, auditoria equipment.identity.update, equipment.upserted para a central sem token. EquipmentPhotoService + core_equipment_photos + GET/POST/DELETE /equipment/:id/photos (3 MB, 12 por maquina, /uploads/equipamentos). Ficha: tipo pelo nome, placa, km com data, telefone do dono, vinculoDeEstoque, CorrigirIdentidadeCard (campos travados pela unidade, virar celular limpa placa/km, tipo antigo mostrado como antigo) e FotosDoEquipamentoCard; cadastro com tipo em lista e placa/km condicionais |
| DEPOIS | Existem PATCH /equipment/:id/identidade, com motivo obrigatório para identidade, evento identidade_corrigida (antes -> depois) e auditoria; km_registrado; chassi/placa alheios dão 409; campos travados pela unidade da loja. Existem também as colunas odometer_km e plate, tabela e rotas de fotos, cadastro com tipo em lista e placa/km condicionais, e cartões de correção e de fotos na ficha. |
| Arquivos | server/src/services/core/EquipmentIdentityRules.ts, server/src/services/core/EquipmentIdentityService.ts, server/src/services/core/EquipmentPhotoService.ts, server/src/services/core/EquipmentService.ts, server/src/db/schema.ts, server/src/app.ts, server/src/routes/v1/core.ts, src/lib/api/equipamentoIdentidade.ts, src/lib/api/core.ts, src/components/gs/CorrigirIdentidadeCard.tsx, src/components/gs/FotosDoEquipamentoCard.tsx, src/pages/gs/EquipamentoFichaPage.tsx, src/pages/gs/EquipamentosPage.tsx, server/tests/identidade-do-equipamento.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/identidadeDoEquipamento.test.tsx, docs/audits/remediacao/migracoes/OFI.md, server/tests/barcode-labels.test.ts, server/tests/plaquinhas-pool.test.ts |
| COMMIT | 44bd0c3, 73dcd05 |
| TESTES | server/tests/identidade-do-equipamento.test.ts (12): cadastro com tipo, placa e km e suas recusas; correção com motivo, histórico, auditoria e central; sem motivo 400; km que volta pede motivo; duplicado 409; tipo antigo; atendente 403, outra empresa 404; vínculo com a loja trava o chassi; fotos com teto de 12; telefone do dono. src/pages/gs/__tests__/identidadeDoEquipamento.test.tsx (11). Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:10466-10574; server/src/services/core/EquipmentIdentityService.ts:147-281; server/src/db/schema.ts:3131, 3163-3176; src/pages/gs/EquipamentosPage.tsx:625-660; src/pages/gs/EquipamentoFichaPage.tsx:492-549 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-107 — Trocar plaquinha (revogar QR de máquina com adesivo danificado) existe só na API — nenhuma tela chama POST /equipment-tags/:id/replace

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Oficina, PJ Motors / OFI |
| ANTES | POST /equipment-tags/:id/replace existia só na API: nenhuma tela o chamava. 'Danificar' recusava plaquinha associada. |
| Causa | a substituicao existia so na API e nenhuma tela a oferecia; a ficha tambem nao reimprimia |
| Correção | PlaquinhaDaMaquinaCard na ficha do equipamento: Reimprimir plaquinha (POST /labels/equipment/sheet com o id, mesmo numero e QR, janela aberta dentro do clique) e Trocar plaquinha (lista /equipment-tags?status=disponivel, plaquinha nova + motivo, POST /equipment-tags/:tagId/replace, aviso de que a velha foi aposentada e recarga da ficha); sem plaquinha livre, link para Plaquinhas; GET /equipment/:id devolve plaquinha {empresaUsa, bancadaUsa} para so oferecer o que o servidor aceita (celular sem cartao; empresa fora do pool sem troca, com a explicacao); troca so para mecanico e gerente da oficina |
| DEPOIS | PlaquinhaDaMaquinaCard, na ficha do equipamento, oferece 'Reimprimir plaquinha' e 'Trocar plaquinha'. A troca lista as livres (status=disponivel), exige plaquinha nova e motivo, e chama /equipment-tags/:tagId/replace. Só aparece para mecânico e gerente e segue as flags empresaUsa/bancadaUsa do servidor. |
| Arquivos | src/components/gs/PlaquinhaDaMaquinaCard.tsx, src/lib/api/plaquinhaDaMaquina.ts, src/pages/gs/EquipamentoFichaPage.tsx, server/src/routes/v1/core.ts, server/tests/plaquinha-pela-tela.test.ts, src/pages/gs/__tests__/plaquinhaPelaTela.test.tsx |
| COMMIT | 8a4b7a1 |
| TESTES | src/pages/gs/__tests__/plaquinhaPelaTela.test.tsx bloco GAP-PRD-107 (5): troca pela ficha com corpo e número novo; sem livres manda gerar; reimprimir; empresa fora do pool e bancada de celular; caixa sem botão. server/tests/plaquinha-pela-tela.test.ts: flags da ficha. Rodei os dois: verdes. |
| EVIDÊNCIA | src/components/gs/PlaquinhaDaMaquinaCard.tsx:96-142; src/lib/api/plaquinhaDaMaquina.ts:37-46; src/pages/gs/EquipamentoFichaPage.tsx:169, 381-389; server/src/routes/v1/core.ts:12295-12318; server/src/services/core/EquipmentTagPoolService.ts:656-683 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-108 — Moto vendida SEM plaquinha nunca mais ganha vínculo: a plaquinha criada depois fica órfã NOT_SOLD e adotável por qualquer unidade nova

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / PARTIAL_IMPLEMENTATION (após refutação: P2 / PARTIAL_IMPLEMENTATION) |
| Empresa / frente | PJ Motors, Oficina / OFI |
| ANTES | Unidade vendida sem plaquinha levava 409 'não recebe plaquinha nova'. A plaquinha de mesmo chassi ficava NOT_SOLD, sem dono, e adotável por qualquer unidade nova. |
| Causa | o vinculo so existia antes da venda |
| Correção | vinculo tardio em vincularUnidade para unidade vendida por venda (sale ou ecommerce_order): exige ao menos um numero igual entre unidade e plaquinha (CORE_LATE_LINK_NEEDS_IDENTITY), comprador na venda (CORE_LATE_LINK_WITHOUT_BUYER) com CPF/CNPJ (CORE_LATE_LINK_BUYER_WITHOUT_DOCUMENT), nao mexe na identidade da unidade (ela esta no documento do cliente) e carimba na plaquinha o dono espelhado pelo documento, sold_at = data da venda e sale_id da venda de balcao, com eventos stock_linked e sold; plaquinhasVinculaveis(companyId, termo, unitId) esconde a plaquinha com o numero de moto vendida sem plaquinha e, para a unidade vendida, lista so a de mesmo numero; o vinculo direto dessa plaquinha a outra unidade e recusado com CORE_EQUIPMENT_BELONGS_TO_SOLD_UNIT; auditoria unit.equipment.link com tardio; /units/summary conta vendidasSemPlaquinha; tela de Unidades com a fila das vendidas sem plaquinha e o botao Vincular plaquinha (ja vendida) na busca por identidade e na tabela do produto |
| DEPOIS | vincularUnidade aceita vínculo tardio em unidade vendida por venda com comprador de CPF/CNPJ e exige ao menos um número igual. Carimba owner (espelho por documento), sold_at da venda e sale_id, com eventos. As candidatas escondem a plaquinha da moto vendida, o vínculo a outra unidade dá CORE_EQUIPMENT_BELONGS_TO_SOLD_UNIT, e a tela de Unidades tem a fila das vendidas sem plaquinha. |
| Arquivos | server/src/services/core/EquipmentStockLink.ts, server/src/routes/v1/core.ts, src/pages/gs/UnidadesEstoquePage.tsx, src/lib/api/core.ts, server/tests/plaquinha-depois-da-venda.test.ts, src/pages/gs/__tests__/plaquinhaDepoisDaVenda.test.tsx |
| COMMIT | ae93817 |
| TESTES | server/tests/plaquinha-depois-da-venda.test.ts (4): vínculo tardio com sale_status SOLD, sale_id, sold_at e dono espelhado; recusa CORE_EQUIPMENT_BELONGS_TO_SOLD_UNIT; CORE_LATE_LINK_NEEDS_IDENTITY, WITHOUT_BUYER e BUYER_WITHOUT_DOCUMENT sem gravar; rota com resumo vendidasSemPlaquinha, candidatas e auditoria tardio=true. src/pages/gs/__tests__/plaquinhaDepoisDaVenda.test.tsx bloco GAP-PRD-108 (1). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/EquipmentStockLink.ts:332-379, 612, 656-666, 711-719, 798-834, 846-894; src/pages/gs/UnidadesEstoquePage.tsx:721-728, 803, 1014 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional: o bloqueio no PDV de moto vendida sem plaquinha não foi implementado. A ficha o dava como opcional e decisão do dono, e o vínculo tardio já tira a irreversibilidade. |

### GAP-PRD-109 — A Oficina abre OS DE CLIENTE sobre moto que ainda é estoque da PJ Motors — sem recusa nem aviso; a guarda só existe na venda

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | PJ Motors, Oficina / OFI |
| ANTES | A Oficina abria OS com cliente do cadastro sobre moto ainda em estoque da PJ Motors, sem recusa nem aviso. |
| Causa | a abertura de OS nao sabia que plaquinha interna nao vendida e estoque do grupo |
| Correção | resolveVinculos: plaquinha INTERNAL_PJ_MOTORS com sale_status NOT_SOLD recusa customerId com CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER 409 nomeando a loja da unidade em estoque; sem nome, a OS entra como Montagem interna; depois da venda (SOLD) a OS do comprador abre com o cadastro; telas: Abrir OS do PDV da oficina (AbrirOsDialog) e Nova OS do quadro (OficinaPage) mostram o aviso da moto do estoque, travam o cliente, preenchem Montagem interna e mandam customerId nulo |
| DEPOIS | resolveVinculos recusa customerId em plaquinha INTERNAL_PJ_MOTORS NOT_SOLD com 409 CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER, nomeando a loja. Sem cliente, a OS vira 'Montagem interna'. Depois da venda, a OS do comprador abre. AbrirOsDialog e a Nova OS do quadro avisam e travam o cliente. |
| Arquivos | server/src/services/core/WorkshopCoreService.ts, src/components/gs/AbrirOsDialog.tsx, src/pages/gs/OficinaPage.tsx, src/lib/api/fronteiraOficina.ts, server/tests/fronteira-pj-oficina.test.ts, src/pages/gs/__tests__/fronteiraPjOficina.test.tsx |
| COMMIT | e5230fd |
| TESTES | server/tests/fronteira-pj-oficina.test.ts bloco GAP-PRD-109 (2): serviço e rota dão 409 com 'PJ Motors'; sem cliente, customer_name 'Montagem interna' e a plaquinha segue NOT_SOLD; depois da venda a OS do dono abre. src/pages/gs/__tests__/fronteiraPjOficina.test.tsx bloco GAP-PRD-109 (2: PDV e quadro). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/WorkshopCoreService.ts:388-408; src/components/gs/AbrirOsDialog.tsx:40, 114-130, 234-236; src/pages/gs/OficinaPage.tsx:1007, 1016 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-110 — PJ Motors gera, imprime e libera lote de plaquinhas com QR, mas não tem oficina, nenhum perfil dela cadastra máquina (403) e a Oficina não pode usar plaquinha da PJ (CORE_TAG_OTHER_COMPANY): QR impresso responde 404

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | PJ Motors / OFI |
| ANTES | A PJ Motors, sem bancada, gerava, imprimia e liberava lote de plaquinhas. Os números do grupo iam para adesivos que não entram em máquina, e o QR respondia 404. O menu mostrava um cadastro que dava 403 sem explicação. |
| Causa | a regra de quem gera plaquinha perguntava so se a empresa usa plaquinha, e nao se ela tem bancada para cola-la |
| Correção | padrao seguro (opcao c da ficha): EquipmentTagPoolService.empresaTemBancada e exigirBancadaQueColaPlaquinha; gerar lote, imprimir folha (fora da previa) e liberar recusam empresa sem bancada ativa com CORE_TAGS_NEED_WORKSHOP apontando Estoque > Unidades; a adocao da plaquinha da Oficina pela unidade da PJ continua (uses_equipment_tags segue valendo para ela); GET /equipment-tags devolve temBancada e a tela de Plaquinhas mostra o aviso Operacao sem bancada no lugar de Gerar lote, com a instrucao de marcar como danificada o que ja foi gerado; resolveWorkshop com zero bancadas responde CORE_COMPANY_WITHOUT_WORKSHOP 409 |
| DEPOIS | Gerar, imprimir e liberar agora exigem bancada ativa e recusam com CORE_TAGS_NEED_WORKSHOP, que aponta Estoque › Unidades. A prévia do layout continua livre. A tela troca o botão 'Gerar lote' por um aviso, e o botão de cadastrar equipamento só aparece para perfis de oficina. Empresa sem bancada leva 409 CORE_COMPANY_WITHOUT_WORKSHOP em vez de 'atende mais de uma'. |
| Arquivos | server/src/services/core/EquipmentTagPoolService.ts, server/src/routes/v1/core.ts, src/pages/gs/PlaquinhasPage.tsx, server/tests/fronteira-pj-oficina.test.ts, src/pages/gs/__tests__/fronteiraPjOficina.test.tsx |
| COMMIT | e5230fd |
| TESTES | server/tests/fronteira-pj-oficina.test.ts:298-339 afirma, para a PJ: temBancada=false; lote 409 CORE_TAGS_NEED_WORKSHOP com zero plaquinhas criadas; folha e liberação de adesivo legado também 409; prévia 200. Para a Oficina: lote 201 e temBancada=true. Rodei o arquivo: verde. src/pages/gs/__tests__/fronteiraPjOficina.test.tsx (bloco 110, aviso 'Operação sem bancada'): verde. |
| EVIDÊNCIA | server/src/services/core/EquipmentTagPoolService.ts:134-157 (empresaTemBancada, exigirBancadaQueColaPlaquinha), :179 (lote), :444 (liberar), :501-508 (marcar danificada exige só uses_equipment_tags, então a PJ consegue seguir a instrução da tela); server/src/routes/v1/core.ts:12185 (folha), :12098 (temBancada), :12267 (damage aceita gerente_loja), :7199-7207 (CORE_COMPANY_WITHOUT_WORKSHOP); src/pages/gs/PlaquinhasPage.tsx:331-343; src/pages/gs/EquipamentosPage.tsx:132-137. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-111 — Não existe reserva/negociação por UNIDADE (chassi específico): estados reais são só in_stock/sold/baixada; reserva é por quantidade e o e-commerce escolhe por FIFO na captura

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / OWNER_DECISION_REQUIRED |
| Empresa / frente | PJ Motors / OFI |
| ANTES | A reserva era só por quantidade. O pedido online e o PDV escolhiam a moto por FIFO, e a moto negociada no balcão podia sair para outro cliente. |
| Causa | a reserva da pre-venda era por quantidade: nada dizia qual moto era do cliente do sinal |
| Correção | mecanismo implementado com padrao seguro (opcional por documento; sem escolha, a reserva por quantidade de sempre): tabela core_product_unit_holds na DDL canonica (unit_id unico); PUT /quotes/:id/unidades (balcao e gerencia; so pre-venda aberta e na validade, produto do documento e controlado por unidade, ate a quantidade, unidade da empresa e do produto em estoque e nao segurada por outra pre-venda viva; substitui, lista vazia solta; auditoria quote.units.hold); a reserva so vale com o documento aberto e na validade (sqlReservadaPorOutro junta com core_quotes, sem varredura); pickUnitsFifo exclui a segurada por outro documento (pedido online, peca de OS) e diz quantas ficaram de fora; venda de balcao da segurada recusada com CORE_UNIT_HELD nomeando pre-venda, cliente e validade; cancelar, vencer e converter soltam; a edicao apara o excedente; a transferencia entre locais a move por ultimo; GET /quotes/:id devolve unidadesReservadas e serialized por item; GET /units/:productId devolve reserva por unidade; telas: cartao Chassi reservado no detalhe da pre-venda (Escolher chassi com a de outro cliente travada, Soltar chassi) e o PDV nao escolhe moto segurada |
| DEPOIS | A pré-venda pode segurar um chassi específico (opcional; sem escolha, vale a reserva por quantidade). O FIFO, inclusive o da captura online, pula a moto segurada por outro documento vivo. A venda de balcão da moto segurada é recusada com CORE_UNIT_HELD, que nomeia pré-venda, cliente e validade. O PDV não escolhe moto segurada. As duas opções da decisão do dono estão no código, e a escolha é um gesto por documento. |
| Arquivos | server/src/db/schema.ts, server/src/services/core/UnitHoldService.ts, server/src/services/core/ProductUnitService.ts, server/src/services/core/InventoryService.ts, server/src/services/core/StockLocationService.ts, server/src/services/core/QuoteService.ts, server/src/routes/v1/core.ts, src/components/gs/ChassiDaPreVendaCard.tsx, src/pages/gs/OrcamentosPage.tsx, src/pages/gs/PdvPage.tsx, src/lib/api/motoDaPreVenda.ts, src/lib/api/core.ts, server/tests/moto-da-pre-venda.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/motoDaPreVenda.test.tsx, docs/audits/remediacao/migracoes/OFI.md |
| COMMIT | ae93817 |
| TESTES | server/tests/moto-da-pre-venda.test.ts:228-363, bloco GAP-PRD-111 (7 casos): segurar o chassi; conversão leva a segurada; balcão recusa com CORE_UNIT_HELD; pedido online capturado pula a segurada mais antiga e vende a outra (:291-314); cancelar ou vencer solta; recusas; edição e transferência. Rodei: verde. src/pages/gs/__tests__/motoDaPreVenda.test.tsx: verde. |
| EVIDÊNCIA | server/src/services/core/UnitHoldService.ts:185-211; server/src/services/core/ProductUnitService.ts:509-602 (pickUnitsFifo exclui por sqlReservadaPorOutro, junto com core_quotes aberta e na validade); server/src/services/core/InventoryService.ts:688 (venda recusa segurada), :1259 (consumeReservation usa o FIFO filtrado); server/src/routes/v1/core.ts:5107-5143 (PUT /quotes/:id/unidades, com perfis e auditoria quote.units.hold); src/pages/gs/PdvPage.tsx:1001-1014. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-112 — Banco operacional sem nenhum produto serializado nem unidade: o dia 1 da PJ Motors exige marcar produtos como 'Controlado por unidade' e identificar chassis (sem código)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | PJ Motors / OFI |
| ANTES | O banco da loja não tinha produto serializado nem unidade. O equipamento SOLD da Oficina não tinha unidade correspondente. |
| Causa | configuracao de dia 1 que o dono ainda nao fez, sem nada na tela dizendo que falta |
| Correção | o software da configuracao ficou completo: GET /units/summary conta produtosSerializados e semIdentidade; cartao Dia 1 da operacao de motos na tela de Unidades (nenhum produto controlado por unidade; motos do patio sem numero); fila das vendidas sem plaquinha com o vinculo tardio (GAP-PRD-108); o equipamento SOLD orfao da Oficina tem caminho pela ficha (desfazer venda a mao com motivo, GAP-PRD-189) ou fica, se a moto saiu antes do sistema |
| DEPOIS | Todo o caminho de configuração existe pela tela: marcar 'Controlado por unidade', identificar o chassi (PATCH /units/:id) e vincular a plaquinha (POST /units/:id/equipment). O cartão 'Dia 1' de Unidades mostra o que falta a partir de /units/summary. O equipamento SOLD órfão tem volta pela ficha (POST /equipment/:id/owner/desfazer). Não falta linha de código, só a configuração do dono. |
| Arquivos | server/src/routes/v1/core.ts, src/pages/gs/UnidadesEstoquePage.tsx, src/lib/api/core.ts, server/tests/plaquinha-depois-da-venda.test.ts, src/pages/gs/__tests__/plaquinhaDepoisDaVenda.test.tsx |
| COMMIT | ae93817, e5230fd |
| TESTES | server/tests/plaquinha-depois-da-venda.test.ts (contadores de /units/summary): verde. src/pages/gs/__tests__/plaquinhaDepoisDaVenda.test.tsx (cartão Dia 1): verde. Rodei os dois. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:11496-11541 (produtosSerializados, semIdentidade), :11586 (vincular), :11701 (identificar), :10620 (desfazer venda à mão); src/pages/gs/ProdutoFormPage.tsx:1488; src/pages/gs/UnidadesEstoquePage.tsx:692-709. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel: marcar cada produto-moto da PJ Motors como Controlado por unidade; gravar o chassi de cada moto do pátio; vincular a plaquinha da Oficina a cada unidade; decidir o equipamento SOLD órfão da Oficina (manter, ou desfazer pela ficha com motivo). Não abri o banco da loja para confirmar o estado atual. |

### GAP-PRD-113 — Webhook legado sem companyId aceita o token do ambiente sem cerco de tenant; token do .env não é recusado em produção

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | todas (uma credencial confirma pedido de qualquer operação) / FIN |
| ANTES | A rota sem companyId aceitava o token do .env e pulava o cerco de tenant. A rota por empresa sem token no cofre também caía no .env, e nada disso era barrado em produção. |
| Causa | o fallback de desenvolvimento do token do webhook nao tinha a guarda que a API key tem, e o caminho do token de ambiente nao tinha cerco de tenant |
| Correção | asaasEnvFallbackAllowed passa a exigir DEVORA_API_ENV != production E NODE_ENV != production (vale tambem para a chave sandbox do .env); getAsaasWebhookToken nao cai no .env em producao; handlePaymentWebhook usa o token de ambiente so sem empresa provada e so fora de producao, e recusa 403 quando a cobranca e de operacao com token proprio (temTokenDeWebhookProprio); 401 (nao 503) quando ha token cadastrado e o informado nao e nenhum; status de credencial nao reporta token de ambiente recusado; card da tela avisa quando o token em uso e o do ambiente |
| DEPOIS | asaasEnvFallbackAllowed exige DEVORA_API_ENV e NODE_ENV diferentes de production. Em produção getAsaasWebhookToken não cai no .env, e a rota sem empresa só aceita token do cofre (a empresa sai do token). Fora de produção, o token do ambiente não vale para operação com token próprio (403). Com token cadastrado e informado errado a resposta é 401. O status de credencial não diz 'configurado' para token de ambiente recusado. |
| Arquivos | server/src/services/integrations/AsaasCredentialService.ts, server/src/services/core/PaymentService.ts, src/components/gs/WebhookAsaasCard.tsx, server/tests/webhook-asaas-rota-registrada.test.ts |
| COMMIT | 3161eba, 02abad1 |
| TESTES | server/tests/webhook-asaas-rota-registrada.test.ts (describe GAP-PRD-113, 6 casos): em produção a rota sem empresa recusa o .env (401) e o pedido fica aguardando_pagamento; a rota por empresa em produção dá 503; NODE_ENV=production dá 503; fora de produção o .env não atravessa para empresa com token próprio (403); o atalho ainda serve empresa sem token fora de produção (200); o status passa de configured:true/env para configured:false/none em produção. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/integrations/AsaasCredentialService.ts:98-121, 131-135, 244, 272-275; server/src/services/core/PaymentService.ts:1462-1496, 1594-1601; server/src/routes/v1/storefront.ts:1695-1721 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-114 — Parcelamento é selo sem execução: cobrança de cartão vai ao provedor sem installmentCount

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | lojas que preencherem installments_max (hoje nulo em todas) / FIN |
| ANTES | A vitrine publicava 'Parcele em até Nx', mas a cobrança de cartão ia ao Asaas só com value (à vista). O checkout não lia parcelas e a LojaPage não tinha seletor. |
| Causa | o teto de parcelas virava so selo; nada o levava ao checkout nem ao provedor, e o webhook/estorno nao sabiam de plano de parcelas |
| Correção | ParcelamentoNoCartao: lerParcelasDoCheckout (so cartao, inteiro 1..24), conferirParcelasDaLoja dentro da transacao do checkout (teto de CADA loja, parcela minima R$ 5,00; recusa nomeia a loja e nenhum pedido nasce), parcelaCoerente e descreverParcelas. createOrderCharge manda installmentCount+totalValue; intencao guarda installment_count e provider_installment_ref (colunas novas anulaveis); evento do pedido 'em 6x de R$ 100,00'; resposta do checkout traz installments. Webhook acha a intencao pelo installment (parcelas 2..N) e confere o valor pela divisao do plano; refundOrder e cancelOrderCharges vao ao plano (/installments/:id refund/DELETE; AsaasHttpClient.refundInstallment/cancelInstallment); procura de orfas trata o plano como uma cobranca (dedupe por installment, adocao grava provider_installment_ref, cancelamento do plano). Vitrine publica cardInstallmentsMax; LojaPage oferece o seletor 'Parcelas' com o valor de cada parcela (parcelasDoCarrinho, a mesma conta do servidor); lista de cobrancas mostra 'em Nx'. |
| DEPOIS | O checkout lê e valida as parcelas: só no cartão, de 1 a 24, dentro do teto de cada loja e com parcela mínima de R$ 5,00. A recusa acontece dentro da transação, então nenhum pedido nasce. A cobrança vai com installmentCount e totalValue, e a intenção guarda o plano. O webhook de qualquer parcela, o estorno e o cancelamento tratam o plano inteiro. A tela tem o seletor 'Parcelas'. |
| Arquivos | server/src/services/core/ParcelamentoNoCartao.ts, server/src/services/core/OrderChargeService.ts, server/src/services/core/PaymentService.ts, server/src/services/core/AsaasCobrancaOrfa.ts, server/src/services/core/StorefrontService.ts, server/src/services/asaas/AsaasHttpClient.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, src/pages/gs/LojaPage.tsx, src/lib/parcelasDoCarrinho.ts, src/pages/gs/ContasPage.tsx, src/lib/api/core.ts, docs/audits/remediacao/migracoes/FIN.md, server/tests/parcelamento-no-cartao.test.ts, src/pages/gs/__tests__/lojaParcelasNoCartao.test.tsx |
| COMMIT | 7ee0305 |
| TESTES | server/tests/parcelamento-no-cartao.test.ts afirma: corpo com installmentCount 6 e totalValue 600 e sem value; installment_count=6; evento '6x de R$ 100,00'. Também: 400 acima do teto com zero pedidos e zero cobranças; recusa que nomeia a loja; 400 no PIX ou boleto; 400 abaixo de R$ 5,00. Webhook de qualquer parcela confirma o pedido; outra operação dá 403; estorno e cancelamento vão a /installments/:id; timeout adota o plano. src/pages/gs/__tests__/lojaParcelasNoCartao.test.tsx cobre a tela. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/routes/v1/storefront.ts:772 (lerParcelasDoCheckout) e :837 (installments na resposta); server/src/services/core/StorefrontService.ts:1447-1451 (conferirParcelasDaLoja dentro do checkout) e :278 (cardInstallmentsMax); server/src/services/core/ParcelamentoNoCartao.ts:38-107; server/src/services/core/OrderChargeService.ts:174, :274-276 (installmentCount+totalValue), :345-362 (installment_count), :328 (evento 'em 6x de ...'), :476 (cancelInstallment), :652 (refundInstallment); server/src/services/core/PaymentService.ts:1575-1593 (acha pelo plano e depois barra outra empresa); src/pages/gs/LojaPage.tsx:740-782 e :1283-1305 (seletor). Configuração do teto: src/pages/gs/LojaAdminPage.tsx:287 ('Parcelamos em até'), gravando por server/src/routes/v1/core.ts:15964. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Preencher installments_max de cada loja em Loja > Configurações (campo 'Parcelamos em até'). Homologar o cartão parcelado no sandbox Asaas com a credencial da operação. Não verifiquei contra o sandbox real. |

### GAP-PRD-115 — Endereços: sem edição (PUT 404), sem distinção entrega/faturamento, sem destinatário; não usados pelo checkout

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | todas / ECO |
| ANTES | Endereços sem edição (PUT 404), sem tipo entrega/faturamento, sem destinatário, e não usados pelo checkout. |
| Causa | O endereço da conta foi desenhado só para entregar (sem tipo, sem destinatário, sem edição) e o pedido guardava uma linha de texto; a nota do pedido dependia do endereço atual da conta. |
| Correção | Servidor: updateAddress + PUT /loja/portal/enderecos/:id (validação do POST, só da própria conta, 404 na alheia, isDefault=true troca o padrão); core_customer_addresses.kind (entrega\|faturamento\|ambos; sem tipo = ambos com IBGE, entrega sem) e recipient_name; faturar exige IBGE (400 PORTAL_IBGE_OBRIGATORIO), UF conferida contra as 27 siglas e o prefixo do IBGE contra a UF. Checkout com conta: enderecoDoCheckout(uso entrega\|faturamento) com 422 CHECKOUT_ENDERECO_TIPO antes de reservar; billingAddressId opcional, senão faturamentoPadraoDaConta (a entrega, se fatura; senão o de faturamento da conta); o pedido grava o retrato em 19 colunas novas (shipping_*: id de origem, destinatário, rua, número, complemento, bairro, cidade, UF, IBGE; billing_*: id, nome, CEP, rua, número, complemento, bairro, cidade, UF, IBGE) e continua gravando a linha de texto de sempre. recipientForOrder lê o retrato (faturamento; senão entrega com IBGE) antes do caminho antigo. getCustomerOrder devolve shippingAddressDetail e billingAddress. Tela: FormularioDeEndereco (criar/editar, quem recebe, para que serve, aviso de IBGE; não é form aninhado e Enter salva o endereço, não o pedido); "Editar" em Minha conta, com tipo e destinatário na lista; checkout com conta escolhe a entrega entre os que entregam (cadastro ali mesmo) e a "Nota fiscal" entre os que faturam; o texto solto ficou só para o visitante; fechamento travado sem endereço de entrega; o detalhe do pedido mostra quem recebe e o endereço da nota. |
| DEPOIS | Há PUT /portal/enderecos/:id, só na própria conta (alheio dá 404). O endereço tem kind (entrega, faturamento ou ambos) e recipient_name, e faturar exige IBGE conferido com a UF. O checkout usa entrega e faturamento escolhidos (tipo errado dá 422), o pedido grava o retrato em colunas shipping_*/billing_*, e a NF-e lê o retrato. |
| Arquivos | server/src/services/core/CustomerAccountService.ts, server/src/services/core/CheckoutIdentityService.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/OrderInvoiceService.ts, server/src/services/core/CustomerPortalService.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/enderecos-com-retrato.test.ts, src/lib/api/enderecos.ts, src/hooks/useEnderecosDaConta.ts, src/components/gs/FormularioDeEndereco.tsx, src/components/gs/ContaDoCliente.tsx, src/components/gs/CheckoutDaConta.tsx, src/pages/gs/LojaPage.tsx, src/pages/gs/MinhaContaPage.tsx, src/components/gs/__tests__/enderecosComRetrato.test.tsx, src/pages/gs/__tests__/checkoutComConta.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 79eca01 |
| TESTES | server/tests/enderecos-com-retrato.test.ts: PUT corrige, PUT alheio 404, PUT valida, tipos e IBGE, IBGE de outra UF recusado, destinatário, retrato em colunas que não muda ao editar ou apagar, billingAddressId, tipo errado 422, billing alheio 404, detalhe do pedido. Tela: enderecosComRetrato.test.tsx. Rodado: verde. Observação: o texto solto aceito pelo servidor para conta sem shippingAddressId foi contado no GAP-PRD-028. |
| EVIDÊNCIA | server/src/services/core/CustomerAccountService.ts:184-215 (kind, PORTAL_IBGE_OBRIGATORIO, destinatário) e 286-324 (updateAddress); storefront.ts:1327 (PUT); CheckoutIdentityService.ts:291-339; StorefrontService.ts:1460-1463 (colunas do retrato); OrderInvoiceService.ts:178-184; src/components/gs/ContaDoCliente.tsx:349-409 (Editar com FormularioDeEndereco). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-116 — Recuperação de senha sem teto por conta: 10 pedidos = 10 e-mails e 10 tokens vivos

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / SECURITY_RISK |
| Empresa / frente | todas / ECO |
| ANTES | A recuperação de senha não tinha teto por conta: 10 pedidos geravam 10 e-mails e 10 tokens vivos. |
| Causa | pedirRecuperacaoSenha não contava pedidos recentes nem invalidava os tokens pendentes (o código de verificação da rodada 50 já fazia as duas coisas; o reset não). |
| Correção | No molde do código de verificação: por conta, pedido repetido em menos de 2 minutos não gera outro link e no máximo 3 links por hora — em SILÊNCIO, com a mesma resposta 200 de e-mail inexistente (um 429 aqui revelaria que a conta existe); cada link novo invalida (used_at) os pendentes da conta, só o último vale; por origem, 10 pedidos por hora de qualquer e-mail (429 PORTAL_LIMITE_RECUPERACAO), contados em core_portal_limites (PortalLimiteService). Tetos ajustáveis por ambiente (DEVORA_PORTAL_RECUPERACOES_POR_ORIGEM_HORA e DEVORA_PORTAL_RECUPERACOES_POR_CONTA_HORA). |
| DEPOIS | Por conta: repetição em menos de 2 minutos e mais de 3 por hora são ignoradas em silêncio, com a mesma resposta de e-mail inexistente. Cada link novo invalida os pendentes. Por origem: 10 por hora, e o 11º dá 429. Os tetos são ajustáveis por variável de ambiente. |
| Arquivos | server/src/services/core/CustomerPortalService.ts, server/src/services/core/PortalLimiteService.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/recuperacao-de-senha-com-teto.test.ts |
| COMMIT | bda3ca3 |
| TESTES | server/tests/recuperacao-de-senha-com-teto.test.ts: 10 pedidos geram 1 e-mail e 1 link vivo com respostas iguais; 4º espaçado da hora silencioso; passada a hora volta; conta no teto responde igual a inexistente; link antigo inválido e o novo redefine; 11º da origem 429. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/CustomerPortalService.ts:1032 (REENVIO_MINIMO_MS=2min), 1036-1041 (teto por origem), 1049-1062 (teto por conta), 1066-1072 (invalida pendentes); PortalLimiteService.ts:62 e 66 (10/origem e 3/conta por hora); storefront.ts:1520-1523 (repassa a origem). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-117 — Não existe tela para cadastrar credencial de transportadora — só POST na API

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / MISSING_IMPLEMENTATION (após refutação: P2 / MISSING_IMPLEMENTATION) |
| Empresa / frente | Todas / LOG |
| ANTES | Não havia tela para cadastrar credencial de transportadora. Só o POST na API, com curl e JWT. |
| Causa | A rota POST /logistics/carriers/credentials existia sem nenhuma tela; o insumo externo (token) so entrava com curl e JWT. |
| Correção | Componente CredencialMelhorEnvio na tela Loja -> Logistica: ambiente sandbox/producao, token em campo de senha sem autocompletar e limpo apos guardar, e-mail de contato tecnico, Guardar/Testar conexao/Remover com confirmacao na tela, dica mascarada e travas traduzidas. Cliente src/lib/api/logistica.ts (Idempotency-Key por gravacao). Servidor: validacao com motivo (LOGISTICS_CARRIER_INVALID, LOGISTICS_ENVIRONMENT_INVALID, LOGISTICS_CREDENTIALS_REQUIRED, LOGISTICS_CONTACT_EMAIL_INVALID), auditoria logistics.credential_saved/removed so com transportadora e ambiente, DELETE /logistics/carriers/:carrier/credentials, test-connection com transportadora validada, resposta com access.locks. Tenant pelo companyId da sessao; permissao logistics.config.manage (gerente_loja, estoquista, gestor, admin_geral). |
| DEPOIS | Loja → Logística tem o quadro Credencial do Melhor Envio: ambiente sandbox/produção, token em campo de senha limpo após guardar, e-mail de contato, Guardar/Testar conexão/Remover. O servidor valida com motivo, audita sem o token, isola pelo companyId da sessão, exige logistics.config.manage e aceita token de produção mesmo com a trava desligada. |
| Arquivos | src/components/gs/CredencialMelhorEnvio.tsx, src/lib/api/logistica.ts, src/lib/api/core.ts, src/pages/gs/LogisticaPage.tsx, server/src/routes/v1/logistics.ts, server/src/services/logistics/LogisticsCredentialService.ts, src/pages/gs/__tests__/LogisticaCredencial.test.tsx, server/tests/melhor-envio-producao.test.ts |
| COMMIT | b6ce6bd, 7a58d47, 37f2624 |
| TESTES | melhor-envio-producao.test.ts, describe GAP-PRD-117 (:409-538): produção guardada com a trava desligada; troca de token sem linha duplicada; recusas 400; auditoria sem token; caixa 403; isolamento de tenant; teste de conexão 401 grava a falha. src/pages/gs/__tests__/LogisticaCredencial.test.tsx e LogisticaPage.test.tsx. Rodados, verdes. |
| EVIDÊNCIA | src/components/gs/CredencialMelhorEnvio.tsx:101-132 (guardar/testar/remover), :198 (opção Produção) e :211-212 (type=password, autoComplete=off). src/pages/gs/LogisticaPage.tsx:222. src/lib/api/logistica.ts:66 e :80. server/src/routes/v1/logistics.ts:279-321 (POST com Idempotency-Key, lerEntradaDeCredencial, recordAudit logistics.credential_saved só com carrier/ambiente, companyId de req.auth), :324-346 (DELETE com auditoria) e :348-359 (test-connection com carrier validado). LogisticsCredentialService.ts:168-207 (validação 400 com códigos). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Nenhum para esta ficha (a tela existe). O token em si é o insumo do GAP-PRD-030. |

### GAP-PRD-118 — Correios e Jadlog: adapter sem HTTP real (cotação simulada, conexão/rastreio 'pendente'), com prontidão marcando IMPLEMENTADO = ok fixo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / LOG |
| ANTES | Correios e Jadlog não tinham HTTP real (cotação simulada, conexão e rastreio pendentes). Mesmo assim a prontidão marcava IMPLEMENTADO = ok fixo para as três. |
| Causa | O checklist e a tela Integracoes afirmavam uma integracao direta que o codigo nao tem. |
| Correção | Prontidao: Correios/Jadlog com implemented=false e um item so SEM INTEGRACAO DIRETA (blocked) dizendo que os servicos saem pelo Melhor Envio e que contrato direto exigiria programacao; fora de blockingReasons. Integracoes: correios NOT_IMPLEMENTED (rotulo "Sem integracao direta" na tela). Painel da integracao: capacidades reais (Melhor Envio com etiqueta/rastreio/cancelamento; Correios/Jadlog sem nada, directIntegration=false; generic = despacho manual). Mensagens do adapter honestas; rastreio simulado nao opera em servidor de producao. .env de exemplo sem as variaveis mortas. it.skip vazios viraram teste. ESTADO-ATUAL, KNOWN_LIMITATIONS, CHECKPOINT e GO_LIVE_CHECKLIST alinhados. |
| DEPOIS | A ficha aceitava duas correções e a escolhida foi a honestidade. Correios e Jadlog saem com implemented=false e um único item SEM INTEGRAÇÃO DIRETA (blocked) apontando o Melhor Envio, fora de blockingReasons, mesmo com credencial guardada. Integrações diz NOT_IMPLEMENTED. O teste de conexão responde sem integração direta, e em servidor de produção não há simulação. |
| Arquivos | server/src/services/logistics/LogisticsReadinessService.ts, server/src/services/logistics/LogisticsCarrierAdapter.ts, server/src/services/integrations/IntegrationsService.ts, server/src/routes/v1/core.ts, .env.example, .env.production.example, docs/ESTADO-ATUAL.md, docs/KNOWN_LIMITATIONS.md, docs/CHECKPOINT.md, docs/GO_LIVE_CHECKLIST.md, src/pages/gs/GestaoPages.tsx, server/tests/correios-jadlog-honestos.test.ts, server/tests/prompt17-logistics-enterprise.test.ts, server/tests/logistica-operacao.test.ts, server/tests/melhor-envio-documento-honesto.test.ts, src/pages/gs/__tests__/LogisticaPage.test.tsx |
| COMMIT | 2cfc103, 47d82c8 |
| TESTES | server/tests/correios-jadlog-honestos.test.ts: it.each correios/jadlog com implemented=false e item único blocked citando o Melhor Envio; credencial não torna implementado; ETIQUETA/RASTREAMENTO do Melhor Envio acendem pelo fato; linha Correios NOT_IMPLEMENTED; test-connection com SEM INTEGRAÇÃO DIRETA; sem evento simulado em produção; .env e documentos coerentes. prompt17-logistics-enterprise.test.ts. Rodados, verdes. |
| EVIDÊNCIA | server/src/services/logistics/LogisticsReadinessService.ts:124-151 (Correios/Jadlog implemented=false, item blocked) e :156-162 (IMPLEMENTADO só para o Melhor Envio). LogisticsCarrierAdapter.ts:124 (COM_INTEGRACAO_DIRETA só melhor_envio), :156-167 e :280-291. routes/v1/core.ts:13719-13727 (correios NOT_IMPLEMENTED). docs/ESTADO-ATUAL.md:420. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-119 — Rastreamento de transportadora inexistente: portal e ERP mostram só o código digitado; 'entregue' é clique do operador

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / MISSING_IMPLEMENTATION (após refutação: P2 / MISSING_IMPLEMENTATION) |
| Empresa / frente | Todas / LOG |
| ANTES | O portal e o ERP mostravam só o código digitado, sem transportadora, link ou eventos. trackLogisticsCarrier nunca era chamado e 'entregue' era clique do operador sem origem. |
| Causa | Nao existia envio nem transportadora no pedido: o codigo era texto solto, a linha do tempo era so a do ERP e "entregue" nao tinha origem. |
| Correção | core_orders.shipping_carrier e core_order_events.origin (anulaveis). Despacho (rota de fulfillment -> avancarEtapaDoPedido/despacharPedido): com etiqueta do provedor o codigo vem dela; sem etiqueta exige quem leva (correios/jadlog/melhor_envio/generic/propria) e confere o codigo dos Correios; envio manual registrado com data e operador. Rastreio: sincronizarEnvio (botao) e RastreioAgendado (LOGISTICS_TRACKING_SYNC_MINUTES, padrao 60, ligado no boot) consultam o provedor; marcos viram eventos origem provedor (hora de Brasilia convertida), postado -> pedido expedido e entregue -> pedido entregue com origem provedor; a falha da consulta fica em last_sync_* e aparece no ERP e no portal. "Entregue" pela loja: origem operador + user_id, envio delivered_origin operador. RastreioPublico: link publico por transportadora (Correios oficial; Melhor Rastreio para Melhor Envio/Jadlog; generic/propria sem link). Link na lista de pedidos (servidor), no portal (lista, detalhe, eventos, aviso de falha) e no e-mail "a caminho". Tela: DespachoDoPedido no lugar do prompt. |
| DEPOIS | O despacho exige quem leva (e confere o código dos Correios); o pedido guarda shipping_carrier e o envio manual tem data e operador. O link público é montado pelo servidor e chega à lista, ao portal e ao e-mail. A agenda (ligada no boot) e o botão consultam o provedor: postado vira expedido e entregue vira entregue, com origem provedor. A falha fica gravada e aparece no ERP e no portal. 'Entregue' pela loja leva origem operador e user_id. |
| Arquivos | server/src/services/logistics/EnvioDoPedidoService.ts, server/src/services/logistics/RastreioPublico.ts, server/src/services/logistics/RastreioDoCliente.ts, server/src/services/logistics/RastreioAgendado.ts, server/src/services/logistics/LogisticsCarrierAdapter.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/CustomerPortalService.ts, server/src/services/notifications/EmailService.ts, server/src/routes/v1/core.ts, server/src/config/env.ts, server/src/index.ts, src/components/gs/DespachoDoPedido.tsx, src/pages/gs/GestaoPages.tsx, src/pages/gs/MinhaContaPage.tsx, server/tests/envio-etiqueta-rastreio.test.ts, server/tests/ecommerce-core.test.ts, server/tests/pedido-de-retirada-chega-ao-cliente.test.ts, src/pages/gs/__tests__/PedidosPage.test.tsx, src/pages/gs/__tests__/rastreioNoPortal.test.tsx |
| COMMIT | 2cfc103, 47d82c8 |
| TESTES | server/tests/envio-etiqueta-rastreio.test.ts (:652-839): postado vira expedido com origem provedor, hora de Brasília, e-mail com o link e sem evento duplicado; entregue pela agenda vira entregue com origem provedor e o portal mostra; 503 grava a falha e ela aparece no portal; despacho sem quem leva dá 400; código dos Correios torto dá 400; link Correios na lista; envio manual com operador; entrega própria sem link; etiqueta pendente 409; entregue pela loja com origem operador. PedidosPage.test.tsx e rastreioNoPortal.test.tsx. Rodados, verdes. |
| EVIDÊNCIA | server/src/services/logistics/EnvioDoPedidoService.ts:1127-1249 (despacharPedido), :1256-1304 (entregue com origem operador), :1308-1370 (aplicarSituacao com origem provedor), :1372-1377 (falha gravada) e :1443-1467 (agenda). RastreioAgendado.ts:37-47. src/index.ts:204. RastreioPublico.ts:63-79. RastreioDoCliente.ts:48-115 (aviso de falha). CustomerPortalService.ts:1307 e :1493-1496. EmailService.ts:449. routes/v1/core.ts:13312-13325 (fulfillment via avancarEtapaDoPedido). src/components/gs/DespachoDoPedido.tsx:64-68. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Para os eventos vindos do provedor: o token de produção do Melhor Envio + LOGISTICS_PRODUCTION_ENABLED=true (o mesmo do GAP-PRD-030/120). Transportadora, link e origem do 'entregue' já funcionam sem insumo no despacho manual. |

### GAP-PRD-120 — Etiqueta e envio no provedor não existem; POST /logistics/shipments grava qualquer corpo como 'quoted'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / LOG |
| ANTES | Não havia etiqueta nem envio no provedor. POST /logistics/shipments gravava qualquer corpo como 'quoted', sem pedido, e a expedição era um window.prompt. |
| Causa | O modulo de logistica so cotava: nao havia envio ligado ao pedido, nem cliente HTTP de carrinho/compra/geracao/impressao/cancelamento, e a rota de envio aceitava corpo livre. |
| Correção | core_shipments (um envio vivo por pedido, indice parcial), core_shipment_events (origem + dedupe), core_logistics_settings (declaracao de conteudo padrao 0 = decisao do contador; agencia Jadlog). MelhorEnvioEnvioClient (cart, shipment/checkout, generate, print publico, tracking, cancel, DELETE cart; erro com a frase do provedor, sem token). ProvedorDeEnvio: interface + adapter Melhor Envio pelo mesmo resolveCarrierAccess da cotacao (sandbox so fora de producao; producao exige LOGISTICS_PRODUCTION_ENABLED) + provedor de teste recusado com DEVORA_API_ENV/NODE_ENV=production no registro e no uso. EnvioDoPedidoService: prontidaoDaEtiqueta (token, medidas, remetente do cadastro fiscal, NF-e autorizada do pedido ou declaracao, agencia Jadlog, envio vivo), comprarEtiqueta idempotente (Idempotency-Key) com destinatario confirmado (CPF/CNPJ com digito, UF, CEP igual ao cotado), continuarEtiqueta (saldo que faltou), linkParaImprimir, cancelarEnvio, servicosParaOPedido; auditoria logistics.label_created/label_failed/label_cancelled/shipping_settings_saved sem token. Rotas /logistics/orders/:orderId/shipments\|services\|label, /shipments/:id/continue\|label\|sync\|cancel, /settings/shipping; POST /shipments passou a exigir orderId e a mesma validacao; GET /shipments le core_shipments. Tela: bloco Envio na ficha do pedido, cartao Envio e etiqueta em Logistica. Prontidao ETIQUETA/RASTREAMENTO acendem pelo fato (lastLabelStatus/lastTrackingStatus). |
| DEPOIS | A rota crua exige orderId e passa pela compra da etiqueta do pedido: 400 sem pedido, 404 para pedido alheio. O cliente HTTP faz carrinho → checkout → geração → impressão → rastreio → cancelamento no ambiente da credencial. A compra é idempotente, com destinatário conferido, prontidão antes do HTTP e auditoria sem token. O código de rastreio vem da etiqueta, e a ficha do pedido tem o bloco Envio. |
| Arquivos | server/src/db/schema.ts, server/src/services/logistics/EnvioDoPedidoService.ts, server/src/services/logistics/MelhorEnvioEnvioClient.ts, server/src/services/logistics/ProvedorDeEnvio.ts, server/src/services/logistics/MelhorEnvioClient.ts, server/src/services/logistics/LogisticsService.ts, server/src/services/logistics/LogisticsCredentialService.ts, server/src/services/logistics/LogisticsReadinessService.ts, server/src/routes/v1/logistics.ts, src/lib/api/envios.ts, src/components/gs/EnvioDoPedido.tsx, src/components/gs/ConfiguracaoDeEnvio.tsx, src/pages/gs/GestaoPages.tsx, src/pages/gs/LogisticaPage.tsx, server/tests/envio-etiqueta-rastreio.test.ts, server/tests/logistics.test.ts, src/components/gs/__tests__/EnvioDoPedido.test.tsx, src/components/gs/__tests__/ConfiguracaoDeEnvio.test.tsx |
| COMMIT | 2cfc103, 47d82c8, 37f2624 |
| TESTES | server/tests/envio-etiqueta-rastreio.test.ts (:356-650 e :841-930): corpo qualquer dá 400 LOGISTICS_ORDER_REQUIRED, 0 linhas e 0 chamadas; pedido inexistente ou alheio 404 sem HTTP; prontidão lista o que falta sem HTTP; carrinho→checkout→generate com corpo conferido; clique duplo compra uma vez; declaração só com a decisão; saldo 422 e retomada; impressão e cancelamento; token recusado 502 sem gravar; tenant 404; atendente 403; provedor de teste recusado em produção. logistics.test.ts, EnvioDoPedido.test.tsx, ConfiguracaoDeEnvio.test.tsx. Rodados, verdes. |
| EVIDÊNCIA | server/src/routes/v1/logistics.ts:107-122 e :130-153 (POST /shipments exige orderId e Idempotency-Key; permissão logistics.label.create; companyId da sessão). ProvedorDeEnvio.ts:212-238 (mesmo resolveCarrierAccess; provedor de teste recusado em produção em :197-199). MelhorEnvioEnvioClient.ts:309-395 (cart/checkout/generate/print/tracking/cancel). EnvioDoPedidoService.ts:363, :877, :936 e :1106 (auditoria). LogisticsService.ts:169-177 (createLogisticsShipment removido). src/pages/gs/GestaoPages.tsx:786 e :846 (EnvioDoPedido e DespachoDoPedido no lugar do prompt). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Token de produção do Melhor Envio com permissão de carrinho, compra, geração, impressão e rastreio (Loja → Logística). LOGISTICS_PRODUCTION_ENABLED=true. Saldo na carteira do Melhor Envio. Endereço do remetente completo em Fiscal → Configuração. NF-e autorizada de cada pedido, ou a decisão do contador para ligar a declaração de conteúdo. Agência Jadlog se usar serviço Jadlog. Nenhuma etiqueta real foi comprada: os endpoints só foram provados contra fetch dublado. |

### GAP-PRD-121 — Máquina de estados do fulfillment não impõe ordem: pago→entregue direto e entregue→pago (regressão) respondem 200

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / DATA_INTEGRITY_RISK (após refutação: P2 / DATA_INTEGRITY_RISK) |
| Empresa / frente | Todas / ECO |
| ANTES | pago→entregue e entregue→pago respondiam 200; o servidor aceitava qualquer etapa da lista. |
| Causa | A ordem das etapas existia no servidor (proximaEtapa, ETAPAS_DA_ENTREGA/RETIRADA) e só a tela a usava; o avanço aceitava qualquer etapa da lista a partir de qualquer estado não parado. |
| Correção | advanceFulfillment exige toStatus === proximaEtapa(status, shipping_method), senão 409 CORE_ORDER_INVALID_TRANSITION com details {atual, pedida, esperada}; repetir a etapa atual segue aceito (linha do tempo append-only; é como se corrige o rastreio). Regressão é ação própria: regressFulfillment + POST /core/orders/:id/fulfillment/voltar (gerente_loja), uma etapa para trás, motivo com 5+ caracteres (400 CORE_ORDER_REGRESS_REASON), evento "Etapa desfeita…" com o usuário e auditoria order.fulfillment_regress {de, para, motivo}; pedido parado ou em "pago" = 409; outra empresa = 404. Tela: "Desfazer etapa (voltar para X)" na ficha do pedido (BotaoDesfazerEtapa, motivo no diálogo). |
| DEPOIS | advanceFulfillment exige a próxima etapa (ou repetir a atual) e responde 409 CORE_ORDER_INVALID_TRANSITION. Todo caminho do operador passa origin 'operador'. A exceção 'provedor' vem só da sincronização da transportadora e só para a frente. Voltar é outra rota, só gerente: uma etapa, motivo de 5+ caracteres, evento e auditoria. |
| Arquivos | server/src/services/core/StorefrontService.ts, server/src/routes/v1/core.ts, src/lib/api/pedidos.ts, src/components/gs/AcoesDoPedido.tsx, src/pages/gs/GestaoPages.tsx, server/tests/pedido-maquina-de-estados.test.ts, server/tests/pedido-fulfillment.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/__tests__/acoesDoPedido.test.tsx, src/pages/gs/__tests__/pedidosCancelarEDesfazer.test.tsx |
| COMMIT | 6041783 |
| TESTES | server/tests/pedido-maquina-de-estados.test.ts: pago→entregue 409 (:119), entregue→pago 409 (:134), pular etapa 409, voltar com motivo e auditoria, sem motivo 400, pedido parado 409, atendente/estoquista 403, outra empresa 404. Tela: acoesDoPedido.test.tsx e pedidosCancelarEDesfazer.test.tsx. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/StorefrontService.ts:2267-2297 (próxima etapa; provedor só para frente) e 2358-2418 (regressFulfillment); core.ts:13312-13338 (avanço) e 13344-13366 (voltar: gerente_loja e auditoria order.fulfillment_regress); EnvioDoPedidoService.ts:1158-1165, 1201-1208, 1268-1285 (origin 'operador') e 1341-1367 (provedor só na sincronização); src/components/gs/AcoesDoPedido.tsx:164-177. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-122 — Devolução devolve estoque à prateleira mesmo com o pedido em trânsito/entregue, contradizendo o contrato de markOrderRefunded

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / ECO |
| ANTES | Devolver um pedido expedido ou entregue devolvia o estoque na hora, com o pacote ainda na transportadora, contradizendo markOrderRefunded. Não era transacional. |
| Causa | refundOrder aplicava SALE_RETURN a todo status devolvível, contra o contrato de markOrderRefunded; provedor, estoque e status em passos separados. |
| Correção | Dinheiro e mercadoria viram dois fatos. O reembolso (refundOrder e o aviso de estorno/contestação do provedor, via markOrderRefunded) marca reembolsado e deixa core_orders.return_goods_status = aguardando quando o pedido baixou estoque. O estoque só volta pelo recebimento conferido: OrderReturnService.receberMercadoriaDevolvida / POST /core/orders/:id/devolucao/receber (gerente_loja e estoquista), item a item (0..quantidade), o que não voltou fica no evento como avaria/extravio, auditoria order.return_received, repetir = 409. refundOrder chama o provedor antes (externo) e roda markOrderRefunded + recebimento numa transação; mercadoriaNaMao omitido = sim para pago/separação/conferência/embalado/pronto para retirada, não para expedido/entregue. Tela: Devolver pergunta se o pacote voltou; badge "Mercadoria a conferir"; cartão "Mercadoria devolvida a conferir" na ficha. |
| DEPOIS | Dinheiro e mercadoria são fatos separados. O reembolso marca return_goods_status='aguardando', e o estoque só volta no recebimento conferido, item a item, com auditoria e 409 em repetição. mercadoriaNaMao omitido vale sim antes de expedir e não para expedido/entregue. Pedido, contrapartida e recebimento rodam numa transação, depois da chamada ao provedor. |
| Arquivos | server/src/services/core/OrderReturnService.ts, server/src/services/core/OrderChargeService.ts, server/src/services/core/StorefrontService.ts, server/src/routes/v1/core.ts, server/src/db/schema.ts, src/lib/api/pedidos.ts, src/components/gs/AcoesDoPedido.tsx, src/components/gs/RecebimentoDaDevolucao.tsx, src/pages/gs/GestaoPages.tsx, server/tests/pedido-devolucao-dinheiro-e-mercadoria.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/__tests__/devolucaoDoPedido.test.tsx, src/pages/gs/__tests__/pedidosDevolucao.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 4163e64 |
| TESTES | server/tests/pedido-devolucao-dinheiro-e-mercadoria.test.ts, bloco GAP-PRD-122 (:180-338): expedido devolvido não devolve estoque; recebimento devolve só o conferido; pago devolve na hora; entregue com mercadoriaNaMao=true; pago com false fica a conferir; webhook conta a mesma história; recusas do recebimento. Tela: devolucaoDoPedido.test.tsx e pedidosDevolucao.test.tsx. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/OrderChargeService.ts:589-715 (684 naMao; 686-712 withTransaction); StorefrontService.ts:1936-1947 (aguardando); OrderReturnService.ts:71-191 (validação item a item, applyMovement SALE_RETURN, recebida); core.ts:13207-13239 (devolver com mercadoriaNaMao) e 13246-13275 (receber: gerente_loja/estoquista, auditoria order.return_received); src/db/sqlite.ts:121-125 (withTransaction com SAVEPOINT para aninhar); AcoesDoPedido.tsx:109-123. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-123 — Cupons de desconto do e-commerce não existem

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / ECO |
| ANTES | Não havia cupom de desconto no e-commerce: nenhuma tabela, rota, tela ou campo. |
| Causa | Funcionalidade inexistente. |
| Correção | Servidor: core_coupons (código por empresa, percentual 0<p<100 ou valor fixo, pedido mínimo, vigência, usos no total e por cliente — padrão 1 —, não cumulativo com promoção por padrão) e core_coupon_redemptions (um uso por pedido; cancelado devolve). CupomService: criar/listar/encerrar (GET/POST/DELETE /core/coupons, gerente_loja; trilha coupon.create/coupon.end), aplicarCupom com recusas nomeadas (CHECKOUT_CUPOM_INVALIDO/AINDA_NAO_VALE/VENCIDO/ESGOTADO/JA_USADO/PEDIDO_MINIMO/SO_PRECO_CHEIO/SEM_DESCONTO) e rateio de maior resto que deixa 1 centavo em cada linha. Checkout: o código desconta só o pedido da empresa dona; nenhuma loja com o código → 400 antes de reservar; o pedido guarda coupon_code/discount_cents e cada item o seu discount_cents com total_cents líquido — cobrança, NF-e (OrderInvoiceService: vProd/vDesc por item), relatórios e DRE seguem certos sem aprender cupom; cancelOrder (cliente, loja, reserva vencida) libera o uso. POST /loja/checkout/cupom simula sem gravar; teto de códigos ERRADOS por origem (20/h, DEVORA_PORTAL_CUPONS_ERRADOS_POR_ORIGEM_HORA; só o erro conta) no simulador e no checkout. Portal: detalhe com discountCents/couponCode. Telas: Cupons de desconto (/sistema/cupons, menu Produtos), campo do cupom na gaveta do carrinho (aplica, mostra desconto e total, refaz a conta quando o carrinho muda, Enter não fecha o pedido), linha do cupom no detalhe do pedido do portal e na ficha do pedido no ERP. |
| DEPOIS | Existem core_coupons e core_coupon_redemptions, com gestão criar/listar/encerrar (gerente_loja e auditoria). O checkout aplica o cupom com validade, uso por cliente e total, pedido mínimo e não cumulativo por padrão, rateia nos itens, libera o uso ao cancelar e tem teto de códigos errados por origem. Há tela /sistema/cupons e campo no carrinho. Nenhum cupom vale até o dono criar um. |
| Arquivos | server/src/services/core/CupomService.ts, server/src/services/core/StorefrontService.ts, server/src/services/core/OrderInvoiceService.ts, server/src/services/core/CustomerPortalService.ts, server/src/services/core/PortalLimiteService.ts, server/src/routes/v1/core.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/cupom-de-desconto.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/cupons.ts, src/pages/gs/CuponsPage.tsx, src/components/gs/CupomDoCarrinho.tsx, src/pages/gs/LojaPage.tsx, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/GestaoPages.tsx, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, src/pages/gs/__tests__/cuponsPage.test.tsx, src/pages/gs/__tests__/cupomNoCarrinho.test.tsx, src/pages/gs/__tests__/meuPedidoComCupom.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 5d910f9, 9d51033 |
| TESTES | server/tests/cupom-de-desconto.test.ts: criar/recusar/duplicado/encerrar; 10% rateado com NF-e vDesc; valor fixo com mínimo; código inexistente 400 sem reservar; vencido; uso por cliente e liberação ao cancelar; esgotado; não cumulativo; duas lojas; simular sem gravar; 429 no teto; rateio exato. Tela: cuponsPage.test.tsx e cupomNoCarrinho.test.tsx. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/CupomService.ts:149-255 (aplicarCupom e recusas nomeadas) e 331 (liberarUsoDoCupom); StorefrontService.ts:1397-1414 (rateio no pedido) e 2072 (cancelamento libera); core.ts:13477-13533 (rotas com requireProfile e recordAudit); storefront.ts:543 e 794 (teto de código errado); src/router/gsRoutes.tsx:619; LojaPage.tsx:1318 (CupomDoCarrinho). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-124 — Tela de Pedidos não tem botão para cancelar pedido aguardando pagamento (a rota existe)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / ECO |
| ANTES | A tela de Pedidos só oferecia 'Baixar pagamento' para pedido aguardando pagamento. A reserva ficava presa até 25 h ou até o cliente cancelar pelo portal. |
| Causa | A rota existia e a tela não oferecia o gesto; a rota não pedia motivo nem deixava rastro. |
| Correção | Botão "Cancelar" ao lado de "Baixar pagamento" (BotaoCancelarPedido: motivo no diálogo, em branco não chama o servidor, recusa do servidor com as palavras dele). A rota do ERP exige motivo (400 CORE_ORDER_CANCEL_REASON), cancela a cobrança no provedor antes, solta a reserva na hora (cancelOrder) e grava auditoria order.cancel {de, motivo} só quando houve transição. |
| DEPOIS | A linha aguardando_pagamento mostra 'Cancelar' ao lado de 'Baixar pagamento'. O diálogo pede motivo e chama POST /core/orders/:id/cancel. A rota exige motivo (400), cancela a cobrança no provedor, solta a reserva e grava auditoria order.cancel {de, motivo}. |
| Arquivos | server/src/routes/v1/core.ts, src/lib/api/pedidos.ts, src/components/gs/AcoesDoPedido.tsx, src/pages/gs/GestaoPages.tsx, server/tests/pedido-maquina-de-estados.test.ts, src/components/gs/__tests__/acoesDoPedido.test.tsx, src/pages/gs/__tests__/pedidosCancelarEDesfazer.test.tsx |
| COMMIT | 6041783 |
| TESTES | server/tests/pedido-maquina-de-estados.test.ts:277-305: sem motivo = 400 CORE_ORDER_CANCEL_REASON e o pedido segue aguardando; com motivo = 200 cancelado, evento com a nota e uma linha order.cancel com o motivo. cancelamento-cancela-no-provedor.test.ts cobre o provedor. Tela: acoesDoPedido.test.tsx e pedidosCancelarEDesfazer.test.tsx. Rodei: verdes. O teste da rota não confere core_stock.reserved diretamente; a liberação vem de cancelOrder, que chama releaseReservation. |
| EVIDÊNCIA | src/pages/gs/GestaoPages.tsx:941-952 (BotaoCancelarPedido ao lado de Baixar pagamento); src/components/gs/AcoesDoPedido.tsx:38-72 (pedirMotivo, recusa do servidor mostrada); src/lib/api/pedidos.ts:66-69 (body {reason}); server/src/routes/v1/core.ts:13160-13200 (requireProfile gerente_loja/atendente, companyId do token, 400 CORE_ORDER_CANCEL_REASON, cancelOrderCharges antes, recordAudit order.cancel); server/src/services/core/StorefrontService.ts:2050-2063 (releaseReservation de cada item), 2028-2048 (só aguardando_pagamento). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-125 — Portal: sem NF-e/DANFE do pedido, sem link/eventos de rastreio e sem pedido de troca/devolução (só cancelamento pré-pagamento)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas / ECO |
| ANTES | O portal não tinha rota de NF-e/DANFE, nem link de rastreio, nem pedido de devolução. A devolução era só por contato com a loja. |
| Causa | O portal parava no "Entregue": nenhuma rota de documento fiscal para a cliente, rastreio só como texto e devolução só por contato com a loja. |
| Correção | PosVendaDoPortal: GET /loja/portal/pedidos/:id traz trackingUrl (link público quando o código é objeto dos Correios; outro padrão sem link inventado), notaFiscal (número, série, chave, situação) e devolucao (pode pedir, prazo de arrependimento = 7 dias do "entregue" no dia da loja, solicitações). GET /loja/portal/pedidos/:id/nfe/danfe (autorizada ou cancelada, com tarja) e /nfe/xml (nfeProc = nota + protocolo, anexo), só para a dona do pedido (getCustomerOrder; demais = 404, sem sessão = 401). POST /loja/portal/pedidos/:id/devolucao: depois de entregue, arrependimento dentro do prazo (409 PORTAL_DEVOLUCAO_FORA_DO_PRAZO com a data) ou defeito; uma em andamento por pedido; evento e auditoria order.return_requested. Tabela core_order_return_requests. ERP: lista com return_request_status, ficha com returnRequests, POST /core/orders/:id/devolucao/solicitacoes/:id/decidir (gerente_loja, atendente) aprova ou recusa com motivo que a cliente lê (auditoria order.return_request_decided); o reembolso conclui a solicitação. Tela: seções "Nota fiscal" (Ver DANFE, Baixar XML com o x-portal-token) e "Troca e devolução" no detalhe do pedido, link "Acompanhar na transportadora"; na gestão, badge "Devolução solicitada" e o cartão de decisão. |
| DEPOIS | O detalhe do portal traz trackingUrl, notaFiscal e devolucao. Há rotas para o DANFE, o XML nfeProc e o pedido de devolução (arrependimento em 7 dias do 'entregue' no dia da loja, ou defeito). A posse vem de getCustomerOrder: pedido alheio = 404, sem sessão = 401. O ERP lista, decide (com auditoria) e o reembolso conclui. As telas existem nos dois lados. |
| Arquivos | server/src/services/core/PosVendaDoPortal.ts, server/src/routes/v1/storefront.ts, server/src/routes/v1/core.ts, server/src/services/core/StorefrontService.ts, server/src/db/schema.ts, src/lib/api/posVenda.ts, src/lib/api/pedidos.ts, src/components/gs/NotaDoPedido.tsx, src/components/gs/DevolucaoDoPedido.tsx, src/components/gs/SolicitacoesDeDevolucao.tsx, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/GestaoPages.tsx, server/tests/portal-pos-venda.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/__tests__/posVendaDoPortal.test.tsx, src/pages/gs/__tests__/meuPedidoPosVenda.test.tsx, src/pages/gs/__tests__/pedidosSolicitacaoDeDevolucao.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 5d42124 |
| TESTES | server/tests/portal-pos-venda.test.ts (10): DANFE 404 antes de emitir; emitida: DANFE em HTML e XML com <nfeProc>/<protNFe>; nota de outra pessoa = 404 em detalhe/DANFE/XML/devolução e sem sessão = 401; link dos Correios e outro padrão sem link; devolução antes da entrega = 409; arrependimento no prazo = 201 e a segunda = 409; fora do prazo = 409 com a data e defeito ainda aceito; a loja decide, o reembolso conclui; outra empresa = 404. Tela: posVendaDoPortal, meuPedidoPosVenda, pedidosSolicitacaoDeDevolucao. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/storefront.ts:1102-1137 (detalhe com trackingUrl/notaFiscal/devolucao), 1194-1208 (pedidoDaSessao), 1211-1233 (nfe/danfe, nfe/xml), 1239-1258 (devolucao); server/src/services/core/PosVendaDoPortal.ts:97-154 (nota, DANFE, XML), 242-268 (prazo CDC art. 49 no dia da loja), 276-359 (409 FORA_DO_PRAZO, uma solicitação em andamento, evento e auditoria order.return_requested), 362-424 (decisão); server/src/routes/v1/core.ts:13282-13309 (decidir, gerente_loja/atendente, auditoria order.return_request_decided); src/pages/gs/MinhaContaPage.tsx:396, 1345, 1353; src/pages/gs/GestaoPages.tsx:794, 897-899; src/lib/api/posVenda.ts:67 (x-portal-token). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-126 — Variável de deploy LOGISTICS_HOMOLOGATION_TESTS decide se o checkout chama a transportadora, enquanto a tela diz 'Conexão: Real' — a tarja COTAÇÃO SIMULADA nunca sai sem mexer no .env

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 — ajuste P1→P2 (fase 2) / DEPLOYMENT_RISK (após refutação: P2 / DEPLOYMENT_RISK) |
| Empresa / frente | Todas / LOG |
| ANTES | LOGISTICS_HOMOLOGATION_TESTS, uma variável de deploy, decidia se o checkout chamava a transportadora. A tela dizia 'Conexão: Real' a partir de um teste feito a cada GET. |
| Causa | Uma variavel de deploy de teste decidia se o checkout chamava a transportadora, enquanto a tela derivava Conexao: Real de outro caminho (teste de conexao a cada abertura). |
| Correção | LOGISTICS_HOMOLOGATION_TESTS removida do servidor (env.ts, cotacao, homologacao, rota /homologation/run) e dos .env de exemplo; o checkout decide pelo ambiente da credencial. GET /core/logistics/carriers nao chama mais o provedor: Conexao vem do ultimo teste guardado. Prontidao devolve access (mode, chargeable, locks) por transportadora e checkoutCarrier (ativo e por que); a tela troca a tarja PRODUCAO BLOQUEADA (lida da flag) por TRANSPORTADORA NO CHECKOUT / CHECKOUT SEM TRANSPORTADORA com o motivo do servidor, e ganha a coluna No checkout. |
| DEPOIS | LOGISTICS_HOMOLOGATION_TESTS saiu do schema e do caminho da cotação: o checkout decide pelo ambiente da credencial. Abrir a tela não chama o provedor; a coluna Conexão vem do último teste guardado. A tarja virou TRANSPORTADORA NO CHECKOUT / CHECKOUT SEM TRANSPORTADORA com o motivo do servidor, inclusive o nome LOGISTICS_PRODUCTION_ENABLED, e há a coluna No checkout. |
| Arquivos | server/src/services/logistics/LogisticsService.ts, server/src/services/logistics/LogisticsReadinessService.ts, server/src/services/logistics/LogisticsCarrierAdapter.ts, server/src/config/env.ts, server/src/routes/v1/logistics.ts, src/pages/gs/LogisticaPage.tsx, src/lib/api/core.ts, server/tests/melhor-envio-producao.test.ts, src/pages/gs/__tests__/LogisticaCredencial.test.tsx, src/pages/gs/__tests__/LogisticaPage.test.tsx |
| COMMIT | b6ce6bd, 7a58d47 |
| TESTES | melhor-envio-producao.test.ts, describe GAP-PRD-126 (:342-405): sem a variável o checkout chama a transportadora; variável=true não muda nada; GET carriers faz 0 chamadas e a Conexão só reflete o teste pedido; prontidão checkoutCarrier active/readyForProduction pela credencial. LogisticaCredencial.test.tsx e LogisticaPage.test.tsx. Rodados, verdes. |
| EVIDÊNCIA | server/src/config/env.ts:302-312 (sem LOGISTICS_HOMOLOGATION_TESTS; LOGISTICS_EXTERNAL_ENABLED só aparece na sonda). LogisticsService.ts:241-273 (sem flag) e :69-110 (status sem chamada ao provedor). LogisticsReadinessService.ts:249-270 (resumoDoCheckout pelo contrato). src/pages/gs/LogisticaPage.tsx:179-207 (tarja) e :263 (No checkout). O grep de logisticsHomologationTests em src só acha comentários. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-127 — docs/ESTADO-ATUAL.md classifica Melhor Envio como READY_FOR_CREDENTIAL 'token de sandbox e de produção' — produção não existe no código

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / LOG |
| ANTES | docs/ESTADO-ATUAL.md prometia READY_FOR_CREDENTIAL com 'token de sandbox e de produção' quando a produção não existia no código. |
| Causa | Documento de estado e tela Integracoes afirmavam uma producao que o codigo nao tinha, e a linha da tela era constante. |
| Correção | ESTADO-ATUAL: cotacao READY_FOR_CREDENTIAL com o insumo pelo nome (token de producao na tela + LOGISTICS_PRODUCTION_ENABLED=true), etiqueta/rastreio MISSING_IMPLEMENTATION, e secao dizendo o que foi provado e que a chamada real nao foi medida; GO_LIVE_CHECKLIST secao 7, CHECKPOINT e KNOWN_LIMITATIONS alinhados. /core/integrations/status: a linha melhor-envio sai de melhorEnvioIntegrationStatus (mesmo access da cotacao), com rotulo BLOCKED_BY_PROCESS na tela. |
| DEPOIS | A produção agora existe no código (GAP-PRD-030), então READY_FOR_CREDENTIAL para a cotação é verdadeiro. O documento nomeia o insumo (token de produção pela tela + LOGISTICS_PRODUCTION_ENABLED=true), diz que o sandbox não cobra e que nenhuma chamada real foi medida. A linha de Integrações sai do mesmo acesso que decide a cotação, não de um objeto fixo. |
| Arquivos | docs/ESTADO-ATUAL.md, docs/GO_LIVE_CHECKLIST.md, docs/CHECKPOINT.md, docs/KNOWN_LIMITATIONS.md, server/src/routes/v1/core.ts, server/src/services/logistics/LogisticsService.ts, src/pages/gs/GestaoPages.tsx, server/tests/melhor-envio-documento-honesto.test.ts |
| COMMIT | b6ce6bd, a4e22cc |
| TESTES | server/tests/melhor-envio-documento-honesto.test.ts: a linha de Integrações muda com a credencial (READY_FOR_CREDENTIAL, READY_FOR_SANDBOX_TEST, PRODUCTION_ENABLED, BLOCKED_BY_PROCESS com o nome da chave); a frase antiga sumiu; o documento cita LOGISTICS_PRODUCTION_ENABLED e 'nenhuma etiqueta real foi comprada'; env.ts tem a URL de produção e não tem logisticsHomologationTests. Rodado, verde. |
| EVIDÊNCIA | docs/ESTADO-ATUAL.md:420-422 e :447-494. server/src/services/logistics/LogisticsService.ts:120-150 (melhorEnvioIntegrationStatus). routes/v1/core.ts:13730. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-128 — Caixa IMAP da Preço Justo cadastrada mas com autenticação falhando ('Command failed') desde 13/08 e leitura automática desligada

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Preço Justo (única com caixa); as outras cinco não têm caixa / EML |
| ANTES | A caixa da Preço Justo no Gmail tinha a senha recusada ('Command failed') desde 13/08. A leitura automática estava desligada, a tela dizia 'Configurada', e o canal ainda cairia no bug das 25 não lidas. |
| Causa | Externa: a senha gravada é recusada pelo Gmail (senha normal da conta ou senha de app revogada/IMAP desligado). Parte de software: a situação da caixa não distinguia senha recusada de configurada, e o canal ainda cairia no GAP-PRD-035 depois da senha certa. |
| Correção | Falha classificada em credencial/pasta/conexao (authenticationFailed e serverResponseCode do imapflow, texto do provedor em response; "Command failed" sem outro sinal = credencial), gravada em last_error_kind (DDL canônica) e deduzida do texto para a linha antiga — a caixa da Preço Justo já aparece como CREDENTIAL_REJECTED sem correção de dado. readiness CREDENTIAL_REJECTED (mensagem com o passo a passo da senha de app do Gmail/Outlook e do IMAP ativado) e CONNECTION_FAILING. Senha nova (ou outra caixa) apaga o erro antigo. POST /core/mail/inbox/test (requireProfile gerente_loja/gerente_oficina, empresa do token, auditoria mail.inbox.test sem senha): connect + STATUS da pasta + logout, devolve mensagens/não lidas, não lê, não marca, não move; last_ok_at guarda quando funcionou. Tela: situação em português, botão "Testar conexão", aviso na leitura automática com a senha recusada, instrução da senha de app no formulário. O GAP-PRD-035 (pré-requisito citado na ficha) está resolvido no mesmo lote. |
| DEPOIS | A falha agora é classificada (credencial, pasta ou conexão). A linha antiga 'Command failed' já é lida como CREDENTIAL_REJECTED, com o passo a passo da senha de app. Há rota e botão 'Testar conexão' (gestor, empresa do token, auditado), campo 'Senha de aplicativo' e botão 'Ativar' da leitura automática. O pré-requisito GAP-PRD-035 está corrigido. Com a senha de app, nenhuma linha de código falta. |
| Arquivos | server/src/services/core/MailInboxService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/helpers/imapFalso.ts, server/tests/imap-senha-recusada-e-teste-de-conexao.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/core.ts, src/pages/gs/EntradaEmailPage.tsx, src/pages/gs/__tests__/EntradaEmailPage.test.tsx, docs/audits/remediacao/migracoes/EML.md |
| COMMIT | 9738104, b6dcfba |
| TESTES | server/tests/imap-senha-recusada-e-teste-de-conexao.test.ts (11 casos): 'Command failed' vira CREDENTIAL_REJECTED, inclusive na linha gravada como está no banco. Senha nova limpa o erro. Testar conexão não lê, não marca e não move. Recusa responde 200 com ok=false. Sem senha dá 409. O estoquista não testa. Só a caixa do token. EntradaEmailPage.test.tsx: 'senha recusada' e 'Testar conexão'. Rodei: verdes. Não abri o banco real. |
| EVIDÊNCIA | server/src/services/core/MailInboxService.ts:179-187 (lê a falha antiga pelo texto), :199-235 (situação CREDENTIAL_REJECTED/CONNECTION_FAILING), :759-803 (classificarFalha), :1068+ (testarConexao); server/src/routes/v1/core.ts:1294-1346 (upsert com companyId do token por último; teste auditado), :1376-1393 (agenda); src/pages/gs/EntradaEmailPage.tsx:250 (Testar conexão), :458 (Ativar), :473 (aviso de senha recusada), :577 (Senha de aplicativo). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel, na conta Google da caixa da Preço Justo: ativar a verificação em duas etapas, gerar uma senha de app e confirmar que o IMAP está ligado. Depois, colar a senha em Compras › NF-e por e-mail › Senha de aplicativo, clicar 'Testar conexão' e depois 'Ativar' na leitura automática. |

### GAP-PRD-129 — Catálogo sem NCM/CFOP fora da Preço Justo (e 10 de 13 na própria PJ), sem grupo tributário e sem CFOP de venda configurado em nenhuma empresa

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | As seis / FIS |
| ANTES | Faltavam NCM, CFOP e origem nos produtos, grupo tributário e CFOP de venda configurado. A emissão estava bloqueada pelo catálogo nas seis empresas. |
| Causa | A classificacao efetiva (produto, ou o grupo que vale para ele) existia so dentro de TributacaoDoItem; validacao, XML, contagem do checklist e importacao olhavam so o produto. |
| Correção | completarPeloGrupo preenche as lacunas do produto com o grupo (perfil do produto ou grupo unico; CFOP interestadual quando o destinatario e de outra UF) nos pontos onde a venda/pedido e montada: createNfceForSale, createNfeForSale, emissionReadinessForSale, orderInvoiceReadiness e createNfeForOrder. O checklist conta NCM/CFOP/origem/CEST efetivos (LEFT JOIN no grupo que vale), diz quantos usam o do grupo, e a origem ausente em todo lugar passa a FAIL. A entrada de nota sem CFOP de venda configurado cria o produto SEM CFOP (o grupo responde por ele). SQL de conferencia dos produtos ja criados com CFOP de fornecedor em migracoes/FIS.md. |
| DEPOIS | O software deixou a configuração bastar. completarPeloGrupo preenche NCM, CFOP, origem e CEST pelo grupo na emissão e na prontidão. O checklist conta a classificação efetiva, com LEFT JOIN no grupo. A entrada sem CFOP de venda configurado cria o produto sem CFOP. Todos os caminhos de entrada existem: grupos tributários, alteração rápida, sugestões do XML e Compras › Configuração. |
| Arquivos | server/src/services/core/TributacaoDoItem.ts, server/src/services/core/FiscalConfigService.ts, server/src/services/core/FiscalDocumentService.ts, server/src/services/core/FiscalPipelineService.ts, server/src/services/core/OrderInvoiceService.ts, server/src/services/core/NfeImportService.ts, server/tests/prontidao-enxerga-o-grupo-tributario.test.ts, server/tests/entrada-cfop-de-venda.test.ts, server/tests/o-assistente-de-prontidao-fiscal.test.ts, src/pages/gs/FiscalPage.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | bdeaa93, a0d4556 |
| TESTES | server/tests/prontidao-enxerga-o-grupo-tributario.test.ts:344-408: o produto sem NCM, CFOP e origem próprios conta como classificado se o grupo os tem, e a NFC-e sai com eles; CFOP interestadual; o CFOP do produto vence. server/tests/entrada-cfop-de-venda.test.ts:110-122: sem configuração, o produto nasce sem CFOP. Rodei o primeiro: verde. O segundo só li. |
| EVIDÊNCIA | server/src/services/core/FiscalConfigService.ts:777-803 (contagem efetiva com o grupo) e :910-951 (origem FAIL); TributacaoDoItem.ts:990 (completarPeloGrupo); FiscalDocumentService.ts:296 e :500; FiscalPipelineService.ts:622; NfeImportService.ts:1979-1986 (cfop: config.defaultSaleCfop ?? undefined); FiscalPage.tsx:965-974 (atalhos para as telas). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Contador: classificar o catálogo das seis empresas (confirmar em lote as sugestões do XML e classificar o PENDENTE/DIVERGENTE) e informar o grupo tributário de cada empresa (CFOP interno e interestadual, origem, CSOSN/CST). CFOP de venda em Compras › Configuração é opcional. |

### GAP-PRD-130 — E-mail transacional, contador e central vivem só no .env global (com reinício) e a fila já acumula; nenhuma empresa tem destinatário do contador nem usuário contador

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | As seis (EMAIL_* e Supabase são globais; destinatários por empresa: 0 nas 6) / EML |
| ANTES | SMTP, Supabase e backup viviam só no .env global e exigiam reinício. A fila acumulava, e nenhuma empresa tinha destinatário do contador, agenda nem usuário contador. |
| Causa | Configuração nunca feita (SMTP, destinatários, agenda, usuário contador) — insumo do dono e do contador — sem uma prontidão única que a mostrasse. |
| Correção | ProntidaoDasComunicacoes.ts + GET /core/comunicacoes/prontidao (requireProfile gerente_loja/gerente_oficina — mesmo alcance da fila, registrado em cinco-telas-que-batem-na-cara — empresa do token, só leitura): itens carteiro (EMAIL_* faltando + quantas pendentes e desde quando), fila (mensagens que desistiram → Reenviar), remetente (padrão grupo = ok), contador_destinatario, contador_agenda, contador_usuario (perfil contador ativo, com último acesso) e caixa_nfe (opcional sem caixa; falta com senha ausente/recusada/falhando ou leitura automática desligada), cada um com situação ok/falta/opcional, o que fazer, quem fornece (dono/gerente/contador) e onde (link da tela ou ".env do servidor"). Cartão "O que falta para os e-mails desta empresa saírem" na tela E-mails. OPERATIONS.md: EMAIL_* e Supabase são a exceção do .env (relidos sem reinício), o resto é por tela. |
| DEPOIS | EMAIL_* e DEVORA_SUPABASE_* são relidos sem reinício, e o carteiro e a agenda do contador sobem sempre. Destinatário e agenda são por tela (Fechamento do contador), e o usuário 'contador' se cria em Equipe. GET /core/comunicacoes/prontidao e o cartão na tela E-mails dizem, por empresa, o que falta, quem fornece e onde. Com os insumos, nenhuma linha de código falta. |
| Arquivos | server/src/services/notifications/ProntidaoDasComunicacoes.ts, server/src/routes/v1/core.ts, server/tests/comunicacoes-prontidao.test.ts, server/tests/contador-varredura-das-rotas.test.ts, server/tests/cinco-telas-que-batem-na-cara.test.ts, src/lib/api/comunicacoes.ts, src/components/gs/ProntidaoDasComunicacoes.tsx, src/pages/gs/EmailsPage.tsx, src/pages/gs/__tests__/EmailsPage.test.tsx, docs/OPERATIONS.md |
| COMMIT | 9738104, b6dcfba |
| TESTES | server/tests/comunicacoes-prontidao.test.ts (6 casos): sem configuração, lista cada peça que falta, o que fazer e quem fornece. Com SMTP, destinatário, agenda, usuário contador e caixa ligada, tudo fica verde. Mensagem desistida aponta Reenviar. Uma empresa não conta para a outra. Caixa e contador recebem 403. EmailsPage.test.tsx: o cartão lista as peças. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/notifications/ProntidaoDasComunicacoes.ts:79-306; server/src/routes/v1/core.ts:14295-14302 (gerente, empresa do token, só leitura); server/src/services/notifications/EmailService.ts:220-245; server/src/index.ts:193-201; server/src/services/core/TeamService.ts:70-80 ('contador' atribuível); src/pages/gs/EquipePage.tsx:84; src/pages/gs/FechamentoContadorPage.tsx (destinatários e agenda); src/pages/gs/EmailsPage.tsx:247 (ProntidaoDasComunicacoes). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel: preencher no .env do servidor EMAIL_ENABLED=true, EMAIL_FROM, EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_USER e EMAIL_SMTP_PASSWORD (senha de app). Em cada empresa: cadastrar o e-mail do escritório em Fechamento do contador, ligar o envio automático (dia 1 a 28) e criar o usuário com perfil 'Escritório de contabilidade (externo)'. O contador fornece o e-mail e o login. DEVORA_BACKUP_DIR continua lido só no boot, mas é da frente DEP, fora deste lote. |

### GAP-PRD-131 — Dois caixas abertos há semanas no banco operacional (Gringa desde 12/08, Preço Justo desde 26/08) e nenhum alerta de gaveta esquecida

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / UX_OPERATIONAL_RISK |
| Empresa / frente | Gringa, Preço Justo / PAG |
| ANTES | As gavetas da Gringa (desde 12/08) e da Preço Justo (desde 26/08) estavam abertas há semanas. Nenhuma tela avisava, e a venda do dia cairia na gaveta antiga. |
| Causa | Nenhuma tela comparava o dia de abertura da gaveta com o dia da loja, e a lista de gavetas abertas nao existia. |
| Correção | CashService.deOutroDia (dia da loja, fuso America/Sao_Paulo, com os dias) na resposta de GET /core/cash/open e em GET /core/cash/drawers (todas as gavetas abertas da operacao com caixa, quem abriu, fundo, esperado da mesma soma do fechamento); recusa de abrir gaveta ja aberta diz "aberto desde dd/mm/aaaa por X". Tela: faixa no PDV com a data e os dias e botao "Fechar o turno antigo", dialogo do caixa sobe na entrada e repete o aviso; Painel com AvisoCaixasEsquecidos (caixa, quem abriu, desde quando, link para Vendas > Caixa; some sem gaveta velha e em falha); Vendas > Caixa com "Gavetas abertas nesta operacao" fechando qualquer uma com a contagem (opcao de fechamento pelo gestor). Sem trava dura na venda: loja que passa da meia-noite continua vendendo e a fila offline de ontem continua regularizando. |
| DEPOIS | deOutroDia usa o dia da loja, não o dia UTC, e sai em GET /core/cash/open e na lista GET /core/cash/drawers. O PDV mostra uma faixa com a data, os dias e o botão 'Fechar o turno antigo', e o diálogo do caixa sobe na entrada. O Painel mostra AvisoCaixasEsquecidos. Vendas > Caixa lista as gavetas abertas e deixa o gerente fechar qualquer uma, com contagem. O fechamento forçado era opcional na ficha e ficou de fora, por escolha declarada. |
| Arquivos | server/src/services/core/CashService.ts, server/src/routes/v1/core.ts, server/tests/terminais-e-gaveta-por-caixa.test.ts, src/lib/api/terminais.ts, src/components/gs/CaixaDoComputador.tsx, src/components/gs/GavetasAbertas.tsx, src/components/gs/CaixaPdvDialog.tsx, src/pages/gs/PdvPage.tsx, src/pages/gs/PainelPage.tsx, src/pages/gs/OperacaoPages.tsx, src/components/gs/__tests__/gavetasAbertas.test.tsx, src/pages/gs/__tests__/pdvCaixaPorTerminal.test.tsx |
| COMMIT | df7aced, ce00afb |
| TESTES | server/tests/terminais-e-gaveta-por-caixa.test.ts:491-545: gaveta de 30 dias atrás traz deOutroDia na consulta e na lista, e a recusa de abrir diz a data; a de hoje não traz; a lista fica presa à empresa. Tela: gavetasAbertas.test.tsx e pdvCaixaPorTerminal.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CashService.ts:875-886 (deOutroDia) e :908-943 (listarGavetasAbertas); routes/v1/core.ts:3984 e :3998-4007; src/pages/gs/PainelPage.tsx:239; src/components/gs/GavetasAbertas.tsx:195-230; src/pages/gs/PdvPage.tsx:720 e :2510-2513; CaixaDoComputador.tsx:148. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Operação da loja, não código: contar e fechar as duas gavetas abertas desde agosto, em Vendas > Caixa > Gavetas abertas nesta operação. |

### GAP-PRD-132 — Pedido online entregue não vira venda (core_orders.sale_id fica NULL): 'Vendas do período', vendedor e BI ignoram a receita do e-commerce enquanto financeiro e DRE a contam

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | Gringa, Me Mimei, Conceito, PJ Motors, Preço Justo (lojas com vitrine) / ECO |
| ANTES | O pedido online entregue não virava venda. 'Vendas do período', o ranking de vendedor e o BI liam só core_sales, enquanto o financeiro e o DRE contavam a receita online. |
| Causa | Os números de venda liam só core_sales; o pedido online, que não pode virar core_sales sem duplicar a receita, só existia no financeiro e no DRE. |
| Correção | GroupInsights.recorteDoPedidoQueFatura (pedido PAGO, no dia do pagamento, pelo total pago = a régua do DRE). "Vendas do período": coluna Canal e as linhas dos pedidos pagos (cancelado nunca entra; reembolsado continua no dia pago e o reembolso é devolução no dia dele), caveat diz o que entra; total do dia = receita do DRE do dia. "Produtos vendidos": itens dos pedidos pagos (sem frete). "Vendas por vendedor": linha "Loja online (sem vendedor)"; comissão segue só do balcão (declarado). BI /insights/operations: faturamento e vendas com a loja online, onlineOrdersCount/onlineRevenueCents à parte, devoluções com os reembolsos. Painel: onlineRevenueCents/onlineOrdersCount ao lado do faturamento de balcão; os dois somados = "Vendas do período". Telas: coluna "Loja online" e frase no BI; frase no painel. |
| DEPOIS | Aplicada a opção (b) da ficha: o pedido pago entra por recorteDoPedidoQueFatura (paid_at, total pago = régua do DRE). Entra em 'Vendas do período' com a coluna Canal e um aviso, em 'Produtos vendidos', como linha 'Loja online' em vendedor, e no BI e no painel com onlineRevenueCents. core_orders.sale_id segue nulo de propósito. |
| Arquivos | server/src/services/core/GroupInsights.ts, server/src/services/core/ReportsService.ts, server/src/routes/v1/core.ts, src/lib/api/core.ts, src/pages/gs/BiPage.tsx, src/pages/gs/PainelPage.tsx, server/tests/pedido-online-nos-relatorios.test.ts, server/tests/central-de-relatorios.test.ts, src/pages/gs/__tests__/lojaOnlineNosNumeros.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | e3140f7 |
| TESTES | server/tests/pedido-online-nos-relatorios.test.ts (7): total do relatório de vendas = receita do DRE do dia (25.000); painel balcão + online = relatório; 'só canceladas' não traz pedido; reembolsado continua no dia pago; linha de vendedor da loja online; produtos somam os itens online sem frete; o BI inclui o online e os reembolsos. Tela: lojaOnlineNosNumeros. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/GroupInsights.ts:139-142 (recorte), 234-299 (BI soma balcão + online e os reembolsos); server/src/services/core/ReportsService.ts:313-338 (vendas com canal online), 354-385 (produtos com UNION ALL), 401-437 (linha da loja online no vendedor; comissão só do balcão, declarado); server/src/routes/v1/core.ts:7089 (painel); src/pages/gs/BiPage.tsx:102, 124, 137-157; src/pages/gs/PainelPage.tsx:337-342. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Nenhum. A ficha pedia decisão do dono entre (a) e (b). A equipe implementou só (b), porque (a) duplicaria a receita e a baixa de estoque. Se Emanuel quiser (a), seria código novo, mas o comportamento esperado da ficha já está entregue. Produtos, marcas e margem do BI seguem só balcão, e a tela declara isso. |

### GAP-PRD-133 — 'Salvar dados' da conta do cliente devolve 200 e 'Dados atualizados.' sem persistir nada quando a conta não tem cadastro vinculado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / BUG |
| Empresa / frente | preco-justo, gringa, me-mimei, conceito, pj-motors / ECO |
| ANTES | PUT /portal/perfil devolvia 200 'Dados atualizados.' sem gravar nada quando a conta não tinha cadastro vinculado. |
| Causa | core_customer_accounts nao tinha colunas de dados pessoais; o perfil so existia nos cadastros vinculados. |
| Correção | Colunas name/phone/document na conta; PUT grava na conta (e continua refletindo nome/telefone nos cadastros vinculados); CPF/CNPJ declarado uma vez com digito verificador (400) e sem troca por PUT (409), devolvido so mascarado; perfil devolve faltando (regra de cadastro completo). Tela "Meus dados" com campo CPF/CNPJ. |
| DEPOIS | Nome, telefone e documento moram em core_customer_accounts. O PUT grava na conta e reflete nome e telefone nos cadastros vinculados. O GET lê da conta. Nome em branco = 400; documento com dígito errado = 400; troca de documento = 409. |
| Arquivos | server/src/services/core/CustomerAccountService.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, src/components/gs/ContaDoCliente.tsx, server/tests/perfil-mora-na-conta.test.ts, src/components/gs/__tests__/perfilDaConta.test.tsx |
| COMMIT | 4313dbe |
| TESTES | server/tests/perfil-mora-na-conta.test.ts:86-105: conta sem vínculo, PUT {name, phone} = 200, GET seguinte devolve nameSource 'conta', e o banco guarda na conta. Também 107-160: documento mascarado, 400/409, nome em branco não grava pela metade. Tela: perfilDaConta.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CustomerAccountService.ts:594-677 (UPDATE core_customer_accounts, depois o loop nos vínculos), 558-592 (getProfile lê a conta); server/src/routes/v1/storefront.ts:1394-1407 (sessão via exigirCliente, accountId da sessão). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-134 — POST /core/sales em dinheiro é aceito sem cashSessionId mesmo com caixa aberto — a venda nasce sem movimento de gaveta

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / INCONSISTENT_CONTRACT |
| Empresa / frente | preco-justo, gringa, me-mimei, conceito, pj-motors, oficina / PAG |
| ANTES | POST /core/sales em dinheiro sem cashSessionId era aceito com o caixa aberto. A venda nascia sem movimento de gaveta. |
| Causa | createSale so lancava na gaveta quando o corpo trazia cashSessionId; a regra de exigir gaveta morava so no PDV. |
| Correção | createSale calcula a especie que entra na gaveta (dinheiro nao pendente menos troco) e, sem cashSessionId, resolve pela regua de GavetaDoDinheiro antes de gravar qualquer linha: gaveta do caixa do pedido, ou a unica aberta; nenhuma, ou varias sem caixa no pedido -> 409 CORE_CASH_SESSION_REQUIRED nomeando o valor e as gavetas. core_sales.cash_session_id e terminal_id passam a refletir a gaveta resolvida, e o movimento "sale" nasce nela. Vale para toda porta que chama createSale (PDV, conversao de pre-venda, faturamento de consignacao, recebimento de OS). Gaveta informada fechada continua 400 CORE_CASH_SESSION_CLOSED (fila offline inalterada). Venda so em cartao/PIX nao pede gaveta. |
| DEPOIS | Antes de gravar, createSale calcula a espécie que entra na gaveta e, sem cashSessionId, resolve a gaveta pela régua única: a do caixa do pedido ou a única aberta. Se não houver nenhuma, ou houver várias sem caixa no pedido, responde 409 CORE_CASH_SESSION_REQUIRED com o valor. O movimento 'sale' nasce na gaveta resolvida. Resta uma exceção declarada e testada: operação que nunca abriu gaveta continua aceitando. Não há fechamento a desmentir nesse caso. |
| Arquivos | server/src/services/core/GavetaDoDinheiro.ts, server/src/services/core/SalesService.ts, server/tests/dinheiro-so-com-gaveta.test.ts |
| COMMIT | 96fcb09, 089fc5e |
| TESTES | server/tests/dinheiro-so-com-gaveta.test.ts:147-315. Afirma: caixa aberto recebe a venda com um movimento de 5000 (troco descontado); sem gaveta aberta dá 409 sem gravar venda; dois caixas sem caixa no pedido dão 409 nomeando os dois; a venda cai na gaveta do caixa do pedido; o caixa sem gaveta não usa a do colega; gaveta informada fechada dá 400; pré-venda convertida cai no caixa aberto; operação sem gaveta aceita (:263). Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/SalesService.ts:1537-1554 e o INSERT em :1570-1581 com cash_session_id; server/src/services/core/GavetaDoDinheiro.ts:93-220 (régua; :159 e :211 a exceção da operação sem gaveta). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-135 — A suíte de testes do frontend faz requisições HTTP reais a localhost:8787 — na máquina da loja, rodar os testes grava no banco operacional

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P2 / DATA_INTEGRITY_RISK |
| Empresa / frente | todas / DEP |
| ANTES | A suíte de tela fazia requisições HTTP reais a localhost:8787. Na máquina da loja, isso gravava em api_request_logs do banco operacional. |
| Causa | setup do vitest do frontend nao bloqueava rede; cliente deriva a API de host:8787 no jsdom |
| Correção | setup do frontend troca fetch e XMLHttpRequest reais por erro de rede; setup do servidor recusa fetch para localhost:8787 e :3000 |
| DEPOIS | O setup do vitest de tela troca fetch, window.fetch e XMLHttpRequest.send por um erro de rede. O setup do servidor recusa fetch para as portas 8787 e 3000. Os dois setups estão ligados nos vitest.config. |
| Arquivos | src/lib/__tests__/setup.ts, server/tests/setup.ts, src/lib/__tests__/rede-bloqueada.test.ts, server/tests/portas-da-instalacao-bloqueadas.test.ts |
| COMMIT | 2d1a784 |
| TESTES | src/lib/__tests__/rede-bloqueada.test.ts: fetch para localhost:8787 e para example.com rejeita com 'Rede real bloqueada'; XHR.send lança. server/tests/portas-da-instalacao-bloqueadas.test.ts: fetch às portas da instalação rejeita. Rodei os dois: verdes. |
| EVIDÊNCIA | src/lib/__tests__/setup.ts:24-41 (fetchBloqueado e XHR bloqueado); vitest.config.ts:26 (setupFiles); server/tests/setup.ts:158-174 (PORTAS_DA_INSTALACAO 8787 e 3000); server/vitest.config.ts:10. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-136 — Rotas /core/sync/* operam no nó inteiro: gerente da empresa A vê a fila da B e pode disparar bootstrap/revive dos eventos da B

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / SECURITY_RISK |
| Empresa / frente | Todas as seis / SEG |
| ANTES | As rotas /core/sync/* agiam no nó inteiro. O gerente da A via contagens, último evento e último erro da B, revivia os mortos da B e disparava a carga inicial de todas as empresas. |
| Causa | A fila e do no (uma tabela para todas as empresas) e as rotas nao distinguiam quem responde pelo no de quem responde por uma loja. |
| Correção | Decisao do dono resolvida pelo lado seguro, sem alavanca a escolher: quem responde pelo grupo (respondePeloGrupo: gestao em todas as operacoes ativas) ve e age no no; os demais no recorte da operacao da sessao (outboxStatus e reviverMortos aceitam o recorte). POST /sync/bootstrap (historico de todas as operacoes, checkpoint do no) = 403 CORE_SYNC_NODE_SCOPE para quem nao responde pelo no. /sync/revive grava sync.revive na trilha. GET /sync/status devolve escopo e acoes; a tela diz de quem sao as contagens e esconde o botao que o servidor fecha. Menu e rota da tela so para QUEM_RESPONDE_PELA_LOJA (estoquista e atendente tomavam 403 em toda chamada). |
| DEPOIS | Quem não responde pelo grupo (respondePeloGrupo) recebe status e revive filtrados por company_id do token. O bootstrap é 403 CORE_SYNC_NODE_SCOPE para essas pessoas, e o revive grava sync.revive na trilha. A tela diz de quem são as contagens, esconde os botões que o servidor fecha, e o menu e a rota ficam só com QUEM_RESPONDE_PELA_LOJA. |
| Arquivos | server/src/services/sync/OutboxService.ts, server/src/services/sync/SyncService.ts, server/src/routes/v1/core.ts, src/pages/gs/SincronizacaoPage.tsx, src/components/gs/navItems.ts, src/router/gsRoutes.tsx, server/tests/sync-do-no-e-da-operacao.test.ts, server/tests/o-menu-nao-promete-o-que-o-servidor-nega.test.ts, src/pages/gs/__tests__/sincronizacaoEscopoDaOperacao.test.tsx, src/pages/gs/__tests__/audit-portas.test.tsx |
| COMMIT | bed4897, 1d344f2, 4f7e0f1 |
| TESTES | server/tests/sync-do-no-e-da-operacao.test.ts (8 casos): o gerente da A vê pending=1 e dead=1 só da A, sem o texto do erro nem o tipo de evento da B; o revive devolve só o morto da A; o bootstrap dá 403 CORE_SYNC_NODE_SCOPE e a fila continua com 6; o caixa toma 403; o gestor nas duas empresas vê o nó; o gestor só na A continua no recorte. Tela: sincronizacaoEscopoDaOperacao (4 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:13562-13566 (escopoDoSync), :13581-13600 (status com recorte e acoes), :13638-13663 (bootstrap 403 + auditoria), :13671-13689 (revive com recorte + auditoria); server/src/services/sync/OutboxService.ts:464-466 (filtro AND company_id = ?), :474-485, :517-552; server/src/services/auth/IdentityService.ts:390-403; src/pages/gs/SincronizacaoPage.tsx:173,244,333,397-399; src/router/gsRoutes.tsx:654-662. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-137 — Topologia suportada é UMA instância de API por banco: dois processos serializam, mas espera >5 s vira 'database is locked' (500), timers dobram e migrações não têm trava global

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | Todas as seis / DEP |
| ANTES | Nada impedia dois processos de API no mesmo .db. A escrita serializava mas estourava 'database is locked', os timers dobravam e as migrações não tinham trava. |
| Causa | Topologia de uma instância por arquivo nunca imposta pelo software. |
| Correção | core_instancia (DDL canônica) com o dono do banco; services/implantacao/instanciaUnica.ts (BEGIN IMMEDIATE; mesma máquina: pid manda — morto assume na hora, vivo e mudo há 10 min é pid reaproveitado; outra máquina: batida de 10 s, prazo 30 s; quem perde a linha desliga com 1). A API assume antes de migrar e de abrir a porta (espera 12 s, depois sai com 1 e a frase do dono); db:migrate, db:seed e rotacionar-chave --confirmar assumem também. GET /system/release traz a instância e a tela Sistema mostra (verde/vermelho/alerta). DEPLOY.md: uma instância por arquivo. |
| DEPOIS | A tabela core_instancia guarda o dono. tentarAssumir roda em BEGIN IMMEDIATE: na mesma máquina decide pelo pid; em outra máquina, pela batida de 10 s com prazo de 30 s. A API assume antes de migrar e de abrir a porta: espera 12 s e sai com 1 dizendo quem é o dono. Quem perde a linha desliga. db:migrate, seed, conferir-esquema, poda e rotacionar-chave também assumem. /system/release mostra a instância e a tela Sistema também. DEPLOY.md documenta uma instância por arquivo. |
| Arquivos | server/src/services/implantacao/instanciaUnica.ts, server/src/db/schema.ts, server/src/index.ts, server/src/db/migracaoCompleta.ts, server/src/db/seed-cli.ts, server/src/scripts/rotacionar-chave.ts, server/src/routes/v1/system-admin.ts, src/lib/api/sistema.ts, src/pages/gs/SistemaPage.tsx, src/pages/gs/__tests__/SistemaPage.test.tsx, docs/DEPLOY.md, server/tests/uma-instancia-por-banco.test.ts, server/tests/a-segunda-api-nao-sobe-no-mesmo-banco.test.ts |
| COMMIT | 7c4c5a7 |
| TESTES | server/tests/uma-instancia-por-banco.test.ts (regras, espera, perda, ordem no boot, rota): rodei, verde. a-segunda-api-nao-sobe-no-mesmo-banco.test.ts existe, com processos reais; não rodei, porque sobe servidor. SistemaPage.test.tsx: rodei, verde. |
| EVIDÊNCIA | server/src/services/implantacao/instanciaUnica.ts:139-176 (tentarAssumir), :178-192 (batida e liberação), :279-313; server/src/index.ts:53-71 e :115; server/src/db/migracaoCompleta.ts:65; server/src/db/seed-cli.ts:17; server/src/scripts/rotacionar-chave.ts:79; server/src/routes/v1/system-admin.ts:192; docs/DEPLOY.md:96. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-138 — Redação do payload por substring apaga chaves legítimas: 'company_id', 'company_name', 'expansion', 'panel', 'span_*' contêm 'pan'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | Todas as seis / DEP |
| ANTES | A redação do payload comparava por substring e apagava company_id, company_name, expansion, panel, span_days e tokens_total. |
| Causa | Comparação por substring do nome do campo. |
| Correção | OutboxService: o nome é quebrado em palavras (snake, camel, kebab, siglas); palavra proibida ou plural (password, senha, hash, secret, token, apikey, certificate, pfx, csc, xml, pan, cvv, encrypted), sequências api+key, private+key, card+number; campo de contagem (…_total, _count) fica. |
| DEPOIS | O nome do campo é quebrado em palavras (snake, camel, kebab, siglas). A regra olha a palavra proibida ou o plural dela, mais as sequências api+key, private+key e card+number. Campo de contagem (_total, _count) fica. company_id e company_name chegam à central. |
| Arquivos | server/src/services/sync/OutboxService.ts, server/tests/a-redacao-nao-apaga-campo-de-negocio.test.ts |
| COMMIT | c0090c0 |
| TESTES | server/tests/a-redacao-nao-apaga-campo-de-negocio.test.ts: campos de negócio (company_id, company_name, expansion, panel, span_days, tokens_total...) ficam; segredos em camelCase (privateKey, cardNumber, encrypted_value) saem. Rodei: verde. |
| EVIDÊNCIA | server/src/services/sync/OutboxService.ts:176-236 (PALAVRAS_PROIBIDAS, SEQUENCIAS_PROIBIDAS, palavrasDoNome, campoProibido) e :239-249 (redigirPayload). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-139 — Contratos escritos divergem do boot: teste diz 'o servidor NÃO liga o ciclo sem credencial' e a arquitetura documenta 'cache local, fila offline' mais amplos do que existem

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | n/a / DEP |
| ANTES | O teste dizia 'o servidor NÃO liga o ciclo sem credencial', mas o boot liga sempre. Os docs prometiam 'cache local, fila offline' amplos e o molde antigo 'só liga com credencial'. |
| Causa | Titulo de teste e documentos ficaram do molde antigo depois que o if (supabaseConfig()) caiu do boot; so a venda do PDV tem fila offline. |
| Correção | Caso renomeado e reescrito para provar o contrato (sem credencial o ciclo roda, a passada devolve READY_FOR_CREDENTIAL sem rede e a fila acumula sem tentativa, com os nomes oficiais); ARQUITETURA-NUCLEO e ESTADO-ATUAL dizem o alcance real (casca pelo service worker, fila so da venda) e a nota do molde revogado; StagingReadinessService deixa de dizer "IndexedDB + outbox local". |
| DEPOIS | O caso foi renomeado e prova o contrato: sem credencial o ciclo roda, dá READY_FOR_CREDENTIAL, não toca a rede e a fila acumula sem gastar tentativa. ARQUITETURA-NUCLEO diz que a casca vem do service worker e que a fila offline é só da venda. ESTADO-ATUAL marca o molde antigo como revogado. |
| Arquivos | server/tests/sync-worker.test.ts, docs/ARQUITETURA-NUCLEO.md, docs/ESTADO-ATUAL.md, server/src/services/system-admin/StagingReadinessService.ts |
| COMMIT | aeee8ff, 44faa8b |
| TESTES | server/tests/sync-worker.test.ts: afirma workerRunning=true sem credencial, attempted 0, chamadasDeRede 0, pending 1 e attempts 0. Rodei: verde. |
| EVIDÊNCIA | server/tests/sync-worker.test.ts:455-505; server/src/index.ts:169 (startSyncWorker incondicional); docs/ARQUITETURA-NUCLEO.md:23; docs/ESTADO-ATUAL.md:383 e :2776-2783 (nota do molde revogado). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-140 — Banco operacional já diverge do schema canônico em 5 pontos invisíveis ao reconcile e ao teste de drift

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 — ajuste P2→P3 (fase 2) / DATA_INTEGRITY_RISK (após refutação: P3 / DATA_INTEGRITY_RISK) |
| Empresa / frente | Todas (mesmo arquivo) / INT |
| ANTES | O banco operacional divergia do canônico em 5 pontos: DEFAULT, UNIQUE inline antiga, dois índices ausentes e um índice com outra definição. O reconcile e o schema-drift não viam, porque só comparavam colunas. |
| Causa | Nenhuma comparação de DEFAULT/constraint/índice contra um banco novo e nenhum reparo além de coluna (ver a linha do engenheiro). |
| Correção | Nada novo nesta verificação: tentativa de refutar a correção de 1e0a793, que se sustentou. |
| DEPOIS | A cada subida, o migrateCoreSchema compara o banco com um banco novo da build (derivaDoEsquema). Cria índice ausente, recria índice diferente e reconstrói pela DDL canônica a tabela com DEFAULT ou regra divergente, com cópia antes e checagem de linhas, FK e integridade. O que não repara vira pendência nomeada, sem derrubar a subida. O schema-drift agora compara dflt_value e índices não únicos. |
| Arquivos | server/src/db/derivaDoEsquema.ts, server/src/db/consolidacaoDaRemediacao.ts, server/src/db/core-migrations.ts, server/tests/schema-drift.test.ts |
| COMMIT | 1e0a793, 48142a2 |
| TESTES | server/tests/schema-drift.test.ts: banco antigo chega ao mesmo esquema do novo, incluindo índices (ix_stock_movements_kind, ix_fiscal_docs_order) e DEFAULT; o UNIQUE diferente é detectado. Rodei: verde. O clone do banco real (v84 para v85, 5 para 0 divergências) é citado no journal; não repeti. |
| EVIDÊNCIA | server/src/db/core-migrations.ts:2803-2836 (repararEsquema no boot); server/src/db/derivaDoEsquema.ts:188-200 (dflt_value), :435 (compararEsquemas), :687-760 (reconstruirTabelaPelaReferencia com checagens), :832-946 (repararEsquema); server/tests/schema-drift.test.ts:40,64-67,119-158 (dflt e índices no snapshot). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-141 — 81 tabelas legadas mortas no banco real e 72 coleções JSON sem leitor criadas em toda instalação

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | Todas (mesmo arquivo) / DEP |
| ANTES | 81 tabelas legadas ficavam no banco real sem DROP, e 72 coleções sem leitor eram criadas em toda instalação, esvaziadas no reset e levadas no backup. |
| Causa | TABLE_NAMES nunca era podada quando o último leitor saía; a rodada 36 tirou nomes da lista sem oferecer caminho para o arquivo existente. |
| Correção | TABLE_NAMES com as 42 coleções usadas; db/tabelasAposentadas.ts com TABELAS_APOSENTADAS (81 da rodada 36 + 90 desta poda) e podarTabelasAposentadas (só nome da lista, só vazia, só formato de coleção, SAVEPOINT — serve ao passo de consolidação); comando npm run db:podar-legado (ensaio por padrão; --aplicar assume o banco pela trava de GAP-PRD-137, copia antes e apaga); DEPLOY.md e migracoes/DEP.md. |
| DEPOIS | TABLE_NAMES caiu para 20 coleções, todas com leitor. A instalação nova não cria as aposentadas e o reset só limpa as vivas. Para o banco que já existe há o comando db:podar-legado: ensaio por padrão; com --aplicar, trava de instância, cópia antes e só tabela vazia. Ressalva: a poda NÃO está ligada ao passo 85 (DEP.md diz que é opcional). No banco da loja as tabelas ficam até alguém rodar o comando. |
| Arquivos | server/src/db/database.ts, server/src/db/tabelasAposentadas.ts, server/src/scripts/podar-tabelas-aposentadas.ts, package.json, docs/DEPLOY.md, docs/audits/remediacao/migracoes/DEP.md, server/tests/as-tabelas-mortas-saem.test.ts |
| COMMIT | 3add0f8 |
| TESTES | server/tests/as-tabelas-mortas-saem.test.ts (9). Afirma: toda coleção declarada tem leitor fora de db/; a instalação nova cria só elas; nenhuma viva está na lista das aposentadas; a lista cobre as 81 da rodada 36; o ensaio não escreve; aplicar apaga só a vazia, de forma idempotente; o comando recusa com outro dono do banco. Rodado: verde. |
| EVIDÊNCIA | server/src/db/database.ts:32-62 (TABLE_NAMES), :337-345 (reset só com TABLE_NAMES); server/src/db/tabelasAposentadas.ts:139-143 (lista), :168-210 (só nome da lista, formato seq/id/data, vazia, SAVEPOINT); server/src/scripts/podar-tabelas-aposentadas.ts:48-87 (trava, snapshot antes, recusa com a API no ar); package.json:77; docs/DEPLOY.md:125-135; docs/audits/remediacao/migracoes/DEP.md:101-122. Grep: podarTabelasAposentadas só é chamada pelo script. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional: com a API parada, rodar npm run db:podar-legado -- --aplicar no banco da loja. Aposentada com linha fica e é relatada. |

### GAP-PRD-142 — Dois lançamentos legados no banco real com competência no dia UTC, e o backfill de migração repete o padrão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DATA_INTEGRITY_RISK |
| Empresa / frente | Duas operações (ids de empresa cfc491b0… e 9348ff15…) / INT |
| ANTES | Dois lançamentos automáticos da loja tinham competência e vencimento no dia UTC (13/08) em vez do dia da loja (12/08). A reconstrução e o passo 56 repetiam o substr(created_at,1,10). |
| Causa | Competência legada e backfills de migração pelo dia de Greenwich (ver a linha do engenheiro). |
| Correção | Nada novo nesta verificação: tentativa de refutar a correção de 775c535, que se sustentou. |
| DEPOIS | O passo 85 roda corrigirCompetenciaLegada: só lançamento automático com competência igual ao dia UTC e diferente do dia da loja, sem baixa, trilha, cancelamento ou quitação posterior. O vencimento vai junto só quando era igual. Cada linha ganha trilha em core_audit_log e o total fica em core_meta. A reconstrução e o passo 56 usam diaDaLojaSql. O alvo em dc48841 é 84, então o passo 85 roda na primeira subida da loja. |
| Arquivos | — |
| COMMIT | 775c535 |
| TESTES | server/tests/competencia-legada-dia-da-loja.test.ts (3). Afirma: o passo 85 leva as linhas das 21h59 e 23h25 a 12/08 e deixa intactas as baixadas, editadas, digitadas e da tarde; trilha com antes e depois; core_meta com 4 linhas; idempotente. Também: reconstrução e passo 56 pelo dia da loja, e a fonte sem substr. Rodado: verde. Não abri o banco real. |
| EVIDÊNCIA | server/src/db/consolidacaoDaRemediacao.ts:448-459 (item do passo 85), :610-685 (critério, UPDATE, auditoria, core_meta); server/src/db/core-migrations.ts:431-436 (reconstrução com diaDaLojaSql), :1735 (passo 56 COALESCE(due_date, diaDaLojaSql)), :2765-2772 (passo 85 no boot); git show dc48841 core-migrations.ts:79 CORE_TARGET_VERSION = 84. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-143 — Guarda de sincronia dos dois parseReaisToCents prometida em comentário não existe

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / DEP |
| ANTES | Money.ts prometia um teste que compara as duas parseReaisToCents, e o arquivo não existia. |
| Causa | Guarda prometida em comentário e nunca escrita. |
| Correção | O teste importa as duas parseReaisToCents (tela e servidor): 29 casos com o valor escrito à mão; todas as sequências de até 5 caracteres sobre {1,0,.,,} em quatro formas (5456 textos); e uma falsificação que prova que a comparação acusa uma cópia sem a regra do grupo de três. |
| DEPOIS | O arquivo existe e importa as duas cópias: tela (format.ts) e servidor (Money.ts). Roda 29 casos com valor escrito à mão e uma varredura de 5456 textos. Uma falsificação prova que a comparação acusa divergência. O comentário de Money.ts:48-51 passa a ser verdade. |
| Arquivos | src/components/gs/__tests__/dinheiroSincronizado.test.ts |
| COMMIT | 5ad1724 |
| TESTES | dinheiroSincronizado.test.ts: 29 casos exigem [esperado, esperado] nas duas cópias, a varredura exige zero divergências, a falsificação exige que '1.500' seja apanhado. Rodado: verde (dentro dos 74 de tela). |
| EVIDÊNCIA | src/components/gs/__tests__/dinheiroSincronizado.test.ts:25-26 (importa as duas), :47-77 (casos), :84-95 (varredura), :97-111 (falsificação); server/src/services/core/Money.ts:48-51. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-144 — Índice duplicado idêntico na tabela mais quente (razão de estoque)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | Todas / DEP |
| ANTES | core_stock_movements tinha dois índices idênticos (company_id, product_id, created_at). |
| Causa | Dois CREATE INDEX com as mesmas colunas na DDL canônica. |
| Correção | A linha de ix_stock_mov_product saiu da DDL canônica (banco novo não o cria); tests/um-indice-por-pergunta.test.ts cobra, num banco novo levado até o alvo, que nenhuma tabela tenha dois índices de mesma definição; o DROP INDEX IF EXISTS ix_stock_mov_product para o banco existente está em docs/audits/remediacao/migracoes/DEP.md, para o passo de consolidação (o boot não derruba índice, regra 5). |
| DEPOIS | A DDL canônica só cria ix_stock_movements_product. No banco existente, o passo 85 derruba ix_stock_mov_product, e só se o gêmeo existir. |
| Arquivos | server/src/db/schema.ts, server/tests/um-indice-por-pergunta.test.ts, docs/audits/remediacao/migracoes/DEP.md |
| COMMIT | 9835bda |
| TESTES | server/tests/um-indice-por-pergunta.test.ts (2). Afirma: nenhuma tabela tem dois índices de mesma definição num banco levado ao alvo; o razão tem um índice só por (empresa, produto, data). Rodado: verde. |
| EVIDÊNCIA | server/src/db/schema.ts:1465-1470; server/src/db/consolidacaoDaRemediacao.ts:433-447 (DROP INDEX IF EXISTS condicionado ao gêmeo); passo 85 roda no boot da loja (alvo 84 em dc48841). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-145 — Horário de verão: o corte do dia em SQL é um deslocamento fixo de -3h

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / DEP |
| ANTES | O corte do dia no SQL usa -3h fixo, e só a suíte de testes conferia se isso ainda valia. Em produção, nada avisava. |
| Causa | O corte do dia no SQL usa um deslocamento fixo e só a suíte de testes conferia se ele ainda vale; a loja não roda a suíte. |
| Correção | services/core/fusoDaLoja.ts: conferirFusoDaLoja confere agora e os próximos 400 dias de 12 em 12 h pelo Intl (FIXO_VALE, VAI_DIVERGIR com a data, DIVERGE_AGORA) e diz o que fazer; avisarSeOFusoDiverge(logWarn) roda no boot logo depois de prepararBanco (FUSO_DA_LOJA_DIVERGE no log, sem impedir a subida); GET /system/release traz calendario; tela Configurações › Sistema mostra a linha "Relógio da loja" com o estado, o fuso e o que fazer. |
| DEPOIS | conferirFusoDaLoja confere agora e os próximos 400 dias pelo Intl. O boot chama avisarSeOFusoDiverge(logWarn) logo depois de prepararBanco (FUSO_DA_LOJA_DIVERGE, sem impedir a subida). GET /system/release traz o calendário, e a tela Sistema mostra a linha 'Relógio da loja' com o estado e o que fazer. O deslocamento continua fixo; a ficha pedia o aviso, e ele existe. |
| Arquivos | server/src/services/core/fusoDaLoja.ts, server/src/index.ts, server/src/routes/v1/system-admin.ts, server/tests/fuso-da-loja-avisa.test.ts, src/lib/api/sistema.ts, src/pages/gs/SistemaPage.tsx, src/pages/gs/__tests__/SistemaPage.test.tsx |
| COMMIT | a973686 |
| TESTES | server/tests/fuso-da-loja-avisa.test.ts (7). Afirma: hoje o fixo vale; em outubro de 2018 avisa antes, com a data; em janeiro de 2019 diverge agora; regra simulada aparece com a data; o boot só escreve no log quando diverge; /system/release traz o calendário. SistemaPage.test.tsx cobre a linha do relógio. Rodados: verdes. |
| EVIDÊNCIA | server/src/services/core/fusoDaLoja.ts:57-114; server/src/index.ts:76; server/src/routes/v1/system-admin.ts:194; src/pages/gs/SistemaPage.tsx:247-256; src/lib/api/sistema.ts:44. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-146 — core_terminals sem escritor: três FKs apontam para tabela que nenhum cadastro preenche

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas / PAG |
| ANTES | core_terminals não tinha escritor. As três FKs e ux_cash_open_per_terminal ficavam inertes, porque terminal_id era sempre NULL. |
| Causa | Mesma causa raiz do GAP-PRD-039: o cadastro de terminais nao existia. |
| Correção | Escritor de core_terminals (TerminalService + rotas + tela, ver GAP-PRD-039); as tres FKs (core_cash_sessions, core_sales, core_device_tokens) passam a apontar para caixas reais, conferidos por empresa; colunas de trilha anulaveis em core_terminals (created_by, updated_at, deactivated_at, deactivated_by, deactivation_reason) pela DDL canonica. Com caixas, ux_cash_open_per_terminal vincula de verdade (uma gaveta aberta por caixa). Para a gaveta SEM caixa (NULL nao colide no SQLite), o indice unico parcial ux_cash_open_sem_terminal ficou descrito em migracoes/PAG.md com pre-condicao e validado em SQLite de rascunho — nao entrou no boot porque banco com duas gavetas sem caixa abertas faria a subida falhar; a garantia continua em codigo (openSession/reopenSession dentro da transacao). |
| DEPOIS | TerminalService grava core_terminals com company_id, created_by e código por operação. As rotas /core/terminals (criar, renomear, desativar com motivo, reativar) são de gerente e auditadas, e há tela em Configurações > Caixas e terminais. A gaveta por caixa passa a valer pelo índice. O índice ux_cash_open_sem_terminal agora entra na consolidação com pré-condição: é criado se o banco não tem duplicata, senão vira pendência com o caminho para resolver. |
| Arquivos | server/src/services/core/TerminalService.ts, server/src/services/core/TerminalRegistry.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/terminais-e-gaveta-por-caixa.test.ts, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | df7aced, ce00afb |
| TESTES | server/tests/terminais-e-gaveta-por-caixa.test.ts:102-383. Afirma: o gerente cria o caixa com código e auditoria; o nome não se repete; o operador lê mas não cadastra; desativar exige motivo; caixa de outra operação não existe aqui; cada caixa tem a sua gaveta; segunda gaveta no mesmo caixa dá 409. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/TerminalService.ts:210-231 (INSERT); routes/v1/core.ts:4015-4115; server/src/db/schema.ts:1495, 1514, 1537, 3019 (FKs e índice por terminal); server/src/db/consolidacaoDaRemediacao.ts:171-179 e :723-735, :789-801 (índice sem terminal com pré-condição); sqlite.ts:80 (foreign_keys ON). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_BY_ROOT_CAUSE** — Resolvido pela causa-raiz |

### GAP-PRD-147 — Coleções JSON não têm company_id em coluna: isolamento de tenant depende de predicado em JS

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UNABLE_TO_PROVE |
| Empresa / frente | Todas (integrações, Asaas, certificado, maquininha, secrets) / DEP |
| ANTES | Coleções JSON sem company_id em coluna: o isolamento de tenant dependia de predicado em JS, sem garantia estrutural, e api_sessions não tinha poda. |
| Causa | Camada de documentos herdada sem chave de tenant; isolamento só por disciplina de cada serviço. |
| Correção | company_id GENERATED ALWAYS AS (json_extract(data, $.companyId)) VIRTUAL em toda coleção (DDL da tabela nova; ALTER na existente, sem reescrever linha); findRowsDaEmpresa/findOneRowDaEmpresa filtram no SQL e recusam empresa vazia; COLECOES_POR_EMPRESA (integration_secrets, integration_configurations, fiscal_certificate_references, nfce_settings, logistics_carrier_credentials, payment_terminal_configurations, payment_terminal_local_agents): insert sem empresa recusado e update que muda a empresa recusado. Prova por serviço de que A grava e B não vê. Índice sobre company_id e o cuidado com lixo antigo em migracoes/DEP.md. |
| DEPOIS | Toda coleção tem company_id GENERATED do JSON (ALTER VIRTUAL no banco existente). findRowsDaEmpresa filtra no SQL e recusa empresa vazia. Nas 7 coleções de segredo, a escrita sem empresa ou que troca a empresa é recusada. O passo 85 cria ix_<coleção>_company, ou registra pendência se houver linha que não é JSON. api_sessions tem poda (SessoesDeApi). Ressalva: a maioria dos serviços ainda lê por findRows com predicado JS (full scan). A ficha aceitava 'ou prova E2E por serviço', e essa prova existe para os 7. |
| Arquivos | server/src/db/database.ts, server/tests/o-segredo-de-uma-empresa-nao-vaza-para-outra.test.ts, server/tests/a-subida-nao-le-as-colecoes.test.ts, docs/audits/remediacao/migracoes/DEP.md |
| COMMIT | a01bb4d |
| TESTES | server/tests/o-segredo-de-uma-empresa-nao-vaza-para-outra.test.ts (14): coluna em toda coleção; filtro SQL; JSON quebrado de B não derruba a leitura de A; recusa de linha sem empresa e de troca de empresa. A seção 3 chama os serviços reais (cofre, Asaas, estado da integração, transportadora, maquininha, CSC, A1): A grava, B não vê. Rodado: verde. |
| EVIDÊNCIA | server/src/db/database.ts:86-97, :118-141, :184-186, :219-241, :258-261; server/src/db/consolidacaoDaRemediacao.ts:740-757, :803-813; server/src/services/api/SessoesDeApi.ts:125,171; server/src/services/api/ApiAuthService.ts:70; leituras por empresa, por exemplo NfceCscService.ts:189 e LogisticsCredentialService.ts:271. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-148 — Boot e prontidão materializam a camada de coleções inteira

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | Todas / DEP |
| ANTES | runMigrations começava com loadDb (todas as coleções, com JSON.parse) a cada boot, cada degrau fazia persistDb, e a prontidão repetia o loadDb. |
| Causa | Degraus 2..19 da camada de documentos herdados do store JSON, que materializavam e regravavam tudo para garantir listas vazias. |
| Correção | runMigrations = ensureSchema + lê db_meta.version + carimba 19 se faltar (os degraus só garantiam colecão vazia, que a tabela já garante). loadDb/persistDb ficam para testes; nenhum caminho de boot as chama. |
| DEPOIS | runMigrations faz ensureSchema, lê db_meta.version e carimba 19 se faltar. Nenhum caminho de src chama loadDb ou persistDb fora de database.ts (grep), e CoreProductionReadinessService só cita loadDb em comentário. |
| Arquivos | server/src/db/migrate.ts, server/tests/a-subida-nao-le-as-colecoes.test.ts |
| COMMIT | dc12706, a01bb4d |
| TESTES | server/tests/a-subida-nao-le-as-colecoes.test.ts (4), com uma linha que o JSON.parse recusa. Afirma: banco em 19 sobe sem abrir linha; degrau antigo sobe sem reescrever (seq preservado); banco novo é carimbado; o boot inteiro e a prontidão não materializam. Rodado: verde. |
| EVIDÊNCIA | server/src/db/migrate.ts:33-37; server/src/db/database.ts:150-156 (getSchemaVersion); grep de loadDb( em server/src: só a definição e comentários. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-149 — Botões visíveis sem permissão (latentes) — Faturar/Cancelar de orçamento, Transferir entre locais e seletor de perfil oferecendo gestor/contador

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Nenhuma hoje (os perfis afetados — atendente, estoquista, gerente_loja — não existem no banco real); todas no dia em que forem criados / SEG |
| ANTES | Faturar e Cancelar do orçamento, Transferir entre locais e o seletor de perfil com Gestor e Contador apareciam para perfis que tomavam 403 no servidor. |
| Causa | Telas ROTA_GESTAO oferecendo acoes cujo guarda no servidor e mais estreito que o ambiente; o seletor de perfil lia a lista inteira em vez da regua de assertPodeAtribuir. |
| Correção | OrcamentosPage: podeEscrever (BALCAO_E_GERENCIA + atendente), podeFechar (BALCAO_E_GERENCIA) e podeLiberarVencidos (gerentes), inclusive no dialogo de detalhe. LocaisEstoquePage: podeMexer (gerentes + estoquista), com a frase de consulta para o atendente. GET /core/team/profiles filtra por capacidadeDe x exigenciaDe. Tres testes de orcamento que montavam a tela sem sessao passam a declarar o gerente da loja. |
| DEPOIS | OrcamentosPage usa podeEscrever (BALCAO_E_GERENCIA + atendente), podeFechar (BALCAO_E_GERENCIA) e podeLiberarVencidos (gerentes), iguais aos guardas do servidor. LocaisEstoquePage usa podeMexer (gerentes + estoquista), igual a POST /stock/transfers. GET /team/profiles filtra pela mesma régua de assertPodeAtribuir. |
| Arquivos | src/pages/gs/OrcamentosPage.tsx, src/pages/gs/LocaisEstoquePage.tsx, server/src/routes/v1/core.ts, src/pages/gs/__tests__/botoesLatentesSomem.test.tsx, server/tests/seletor-de-perfil-so-oferece-o-que-se-pode-dar.test.ts, src/pages/gs/__tests__/orcamentoValidade.test.tsx, src/pages/gs/__tests__/orcamentoEditaERenova.test.tsx, src/pages/gs/__tests__/liberacaoComValor.test.tsx |
| COMMIT | 483abd4 |
| TESTES | Tela: src/pages/gs/__tests__/botoesLatentesSomem.test.tsx (5 casos): o estoquista não vê ação de orçamento; o atendente escreve mas não fatura, não cancela e não libera; o atendente não vê Adicionar nem Desativar em locais. Servidor: seletor-de-perfil-so-oferece-o-que-se-pode-dar (o gerente não recebe gestor nem contador; oferta contida no que o servidor aceita; o dono recebe todos). Rodei: verdes. |
| EVIDÊNCIA | src/pages/gs/OrcamentosPage.tsx:45-51, :420-422, :450-596, :1383-1512; src/pages/gs/LocaisEstoquePage.tsx:36, :179, :238, :332; server/src/routes/v1/core.ts:4981/5249/5297 (atendente escreve), :5031 e :5205 (BALCAO_E_GERENCIA), :5227 (gerentes), :3327 (transfers), :9318-9331 (profiles filtrado); src/pages/gs/EquipePage.tsx:141. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-150 — Terminal de PDV confiável (device token) existe só por rota: não há tela para registrar, listar ou revogar

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / MISSING_IMPLEMENTATION |
| Empresa / frente | Todas as seis (core_device_tokens = 0 no banco real) / PAG |
| ANTES | As rotas /auth/device/* existiam só por API. Nenhuma tela registrava, listava ou revogava, e o enroll com terminalId falhava com core_terminals vazia. |
| Causa | As rotas /auth/device/* existiam so por API, sem tela para registrar, listar ou revogar, e sem caixa a que prender o token. |
| Correção | Servidor: enroll valida o caixa (empresa + ligado), devolve id e terminalId e audita auth.device_enroll sem o token; GET /auth/devices traz terminalName/terminalActive; device/login recusa token de caixa desativado (volta a entrar se o caixa for reativado); revoke grava o motivo na auditoria. Tela (Configuracoes > Caixas e terminais > Acesso sem senha, so para admin_geral/gestor como a permissao api.device.*): registrar o computador de um usuario de caixa num caixa, codigo mostrado uma vez com "Guardar neste computador" (grava gs.deviceToken, a mesma chave que a LoginPage le para oferecer "Entrar no PDV deste terminal"), copiar, lista com usuario/caixa/ultimo uso/situacao e revogar com motivo; card "Este computador" mostra e esquece o token guardado; o gerente ve a explicacao em vez do formulario. No PDV, o computador registrado por token opera so a gaveta do proprio caixa (sem "Trocar"). |
| DEPOIS | Enroll exige caixa desta empresa e ligado, devolve o token uma vez só e audita auth.device_enroll sem o token. A lista traz o nome do caixa. A revogação fica presa à empresa, com motivo na auditoria. O login recusa token de caixa desativado. A tela Configurações > Caixas e terminais registra, guarda gs.deviceToken, lista e revoga, com permissão api.device.* (admin_geral e gestor). |
| Arquivos | server/src/routes/v1/auth.ts, server/src/services/core/TerminalRegistry.ts, server/tests/terminais-e-gaveta-por-caixa.test.ts, src/lib/api/terminais.ts, src/pages/gs/TerminaisPage.tsx, src/components/gs/CaixaDoComputador.tsx, src/pages/gs/__tests__/terminaisPage.test.tsx, src/pages/gs/__tests__/pdvCaixaPorTerminal.test.tsx |
| COMMIT | df7aced, ce00afb |
| TESTES | server/tests/terminais-e-gaveta-por-caixa.test.ts:384-490. Afirma: token no Caixa 2 lista o nome e só abre a gaveta dele; caixa alheio dá 400; caixa desligado dá 409; desligar corta o login e reativar devolve; revogação auditada. Tela: terminaisPage.test.tsx (registro, token uma vez, guardar, revogar com motivo, gerente sem formulário). Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/auth.ts:448-500 (enroll e auditoria), :517-567 (lista por empresa), :586-620 (revogação 404 fora da empresa e auditoria com motivo), :380-386 (caixa desativado corta o login); src/lib/api/terminais.ts:106-111; src/router/gsRoutes.tsx:346-351 (/sistema/configuracoes/terminais); src/pages/gs/TerminaisPage.tsx. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-151 — Atalho sem senha ligado no .env desta máquina e usado 184 vezes contra o banco do dono; docker-compose.yml publica em 'development'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | Todas (o banco operacional é um só) / DEP |
| ANTES | O .env da loja tem DEVORA_DEV_QUICK_LOGIN=true e nenhum DEVORA_API_ENV, e o docker-compose publicava em 'development'. |
| Causa | publicacao sem declaracao de ambiente e sem roteiro que conferisse as duas variaveis |
| Correção | Imagem e docker-compose.yml declaram DEVORA_API_ENV=production e DEVORA_DEV_QUICK_LOGIN=false; a conferencia da implantacao BLOQUEIA ambiente nao-producao e acesso rapido ligado (comando sai 1; instalar-servico.ps1 para; tela mostra); GO_LIVE_CHECKLIST cobra DEVORA_API_ENV/NODE_ENV=production, DEVORA_DEV_QUICK_LOGIN ausente e a conferencia sem BLOQUEIA. |
| DEPOIS | O Dockerfile declara NODE_ENV e DEVORA_API_ENV=production. O compose declara production e DEVORA_DEV_QUICK_LOGIN 'false'. A conferência da implantação dá BLOQUEIA para ambiente fora de produção e para acesso rápido ligado, com o que fazer, e aparece no comando, na rota /system/implantacao e na tela Implantação. O instalar-servico.ps1 para, e o GO_LIVE_CHECKLIST cobra. Nenhuma linha de código falta: basta editar o .env da loja. |
| Arquivos | Dockerfile, docker-compose.yml, server/src/services/implantacao/conferenciaDaImplantacao.ts, docs/GO_LIVE_CHECKLIST.md, .env.example, .env.staging.example |
| COMMIT | 38e526a, fb3874f |
| TESTES | a-imagem-docker-guarda-o-que-e-dado (imagem e compose em production, acesso rápido false) e a-conferencia-da-implantacao (BLOQUEIA com o .env de desenvolvimento). Rodados: verdes. As travas antigas (quick-login e producao-nao-entra-sem-senha) não reexecutei; estão na suíte completa medida verde. |
| EVIDÊNCIA | Dockerfile:34-35; docker-compose.yml:31-32; server/src/services/implantacao/conferenciaDaImplantacao.ts:141-191; server/src/routes/v1/system-admin.ts:50; src/pages/gs/ImplantacaoPage.tsx:32,86-91; deploy/windows/instalar-servico.ps1:98; docs/GO_LIVE_CHECKLIST.md:18-33. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Emanuel, no .env da instalação da loja: apagar DEVORA_DEV_QUICK_LOGIN (ou =false) e escrever DEVORA_API_ENV=production e NODE_ENV=production antes do go-live. Não abri esse .env. |

### GAP-PRD-152 — Desativação é global (core_users.active) e um gestor de uma só empresa desativa o admin_geral do grupo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas em que o alvo tem vínculo / SEG |
| ANTES | O gestor de uma única empresa desativava o admin_geral do grupo (core_users.active global). A tela não avisava o alcance. |
| Causa | Senha, ativo, nome e e-mail sao da conta (core_users) e valem em todas as operacoes da pessoa, mas o guarda media so o vinculo da operacao do token; a tela nao dizia o alcance do Desativar e nao havia como tirar alguem de uma operacao so. |
| Correção | Decisao do dono implementada como mecanismo, com padrao seguro: (1) assertPodeMexerNaConta exige que quem age alcance TODAS as operacoes do alvo para senha/desativacao/nome/e-mail (403 CORE_TARGET_BEYOND_YOUR_REACH); gestor e admin_geral seguem pares. (2) Vinculo com alavanca propria: POST /core/team/:id/remove-from-company (recusa a si mesmo 400, ultimo vinculo 409 CORE_LAST_COMPANY_LINK, vinculo de admin_geral 403 CORE_INSTALL_ONLY_PROFILE; apaga so as bancadas desta operacao; reatribui is_default; auditoria team.removed_from_company) e POST /core/team/link para desfazer pelo login sem tocar na senha (mesma regua da criacao; auditoria team.linked). (3) Tela: Desativar confirma e diz o alcance ("a esta e a mais N operacoes do grupo"), a coluna Pessoa diz em quantas outras operacoes a conta entra, "Remover desta operacao" so aparece quando o servidor aceita, nome/e-mail travados fora do alcance, login repetido no cadastro oferece "Dar acesso a esta conta nesta operacao". (4) replaceWorkshopLinks restrito as bancadas da empresa. |
| DEPOIS | Desativar, trocar senha, nome e e-mail exigem alcance sobre todas as operações do alvo (403 CORE_TARGET_BEYOND_YOUR_REACH). As duas alavancas da decisão existem: desativar a conta inteira, ou remover só desta operação. A remoção tem as recusas de si mesmo, último vínculo e admin_geral, e grava auditoria. Existe também religar pelo login. A tela diz o alcance do corte e mostra 'Remover desta operação' só quando o servidor aceita. |
| Arquivos | server/src/services/core/HierarquiaDePerfis.ts, server/src/services/core/TeamService.ts, server/src/routes/v1/core.ts, src/lib/api/equipe.ts, src/pages/gs/EquipePage.tsx, server/tests/hierarquia-da-equipe.test.ts, src/pages/gs/__tests__/equipeHierarquia.test.tsx, server/tests/contador-varredura-das-rotas.test.ts |
| COMMIT | 9c830f6 |
| TESTES | server/tests/hierarquia-da-equipe.test.ts, bloco GAP-PRD-152 (10 casos): [A6] o gestor de uma empresa não desativa o admin_geral multiempresa; o gestor que alcança todas desativa; o gerente da A não troca a senha de quem trabalha onde ele não manda; a remoção preserva os outros vínculos; último vínculo 409; admin_geral 403; religar sem tocar a senha. Tela: equipeHierarquia (7 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/HierarquiaDePerfis.ts:171-181, :208-229, :249-284; server/src/services/core/TeamService.ts:628-633, :684-689, :738-811; server/src/routes/v1/core.ts:9161-9185, :9221-9243 (team.removed_from_company), :9245-9268 (team.linked); src/pages/gs/EquipePage.tsx:51-55, :283-286, :520-539, :851. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-153 — Contrato de variáveis: LOG_LEVEL e DEVORA_PUBLIC_BASE_URL documentados e validados mas nunca lidos; .env.example (dev) e staging não documentam EMAIL_*, DEVORA_UPLOADS_DIR, DEVORA_SUPABASE_BUCKET, RETENCAO; chaves só de teste aparecem no exemplo de produção

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | todas / INT |
| ANTES | LOG_LEVEL e DEVORA_PUBLIC_BASE_URL eram documentados sem leitor. Os exemplos dev e staging omitiam EMAIL_*, UPLOADS, BUCKET e RETENCAO, e chaves só de teste apareciam no exemplo de produção. |
| Causa | A DEP aposentou DEVORA_PUBLIC_BASE_URL (nenhum leitor), mas a mensagem da homologação do Asaas ainda mandava o dono configurá-la, e o tipo da tela ainda a listava como origem do endereço do webhook. O contrato de variáveis confere esquema × leitores × exemplos e não lê mensagem. |
| Correção | AsaasHomologationService: a mensagem manda definir GRUPO_SAMPAIO_PUBLIC_URL (ou ASAAS_WEBHOOK_PUBLIC_URL), a variável que o servidor lê. src/lib/api/asaasWebhook.ts: baseSource passa a ser ASAAS_WEBHOOK_PUBLIC_URL \| GRUPO_SAMPAIO_PUBLIC_URL, o que AsaasWebhookInfo devolve. Trava nova nome-aposentado-nao-volta: nenhum nome de VARIAVEIS_SEM_EFEITO (agora exportada) aparece no código do produto sem comentários, fora da conferência da implantação e do mapa NOMES_LEGADOS do SyncService (que só avisa da troca de nome, sem aceitar o valor). |
| DEPOIS | LOG_LEVEL agora vale (debug<info<warn<error). DEVORA_PUBLIC_BASE_URL saiu do schema e dos exemplos. Os três exemplos documentam EMAIL_*, DEVORA_UPLOADS_DIR, DEVORA_SUPABASE_BUCKET e RETENCAO. As chaves de teste saíram, e a conferência aponta variáveis sem efeito. Mas uma mensagem da homologação Asaas ainda manda o dono configurar DEVORA_PUBLIC_BASE_URL, que não tem leitor. |
| Arquivos | server/src/utils/errors.ts, server/src/config/env.ts, .env.example, .env.staging.example, .env.production.example, docs/DEPLOY.md, server/tests/o-contrato-de-variaveis.test.ts, server/tests/o-log-obedece-o-nivel.test.ts, server/src/services/integrations/AsaasHomologationService.ts, server/src/services/implantacao/conferenciaDaImplantacao.ts, src/lib/api/asaasWebhook.ts, server/tests/nome-aposentado-nao-volta.test.ts, server/tests/homologacao-asaas-cada-verde-executou.test.ts, src/pages/gs/__tests__/integracaoAsaasWebhook.test.tsx |
| COMMIT | b8fc696, fb3874f, 6310793, 615ca38 |
| TESTES | o-contrato-de-variaveis (schema x leitores x exemplos por AST; chaves só da suíte fora dos exemplos) e o-log-obedece-o-nivel (6 níveis) rodados verdes. O teste de contrato não varre mensagens ao usuário, por isso não acusa o texto do Asaas. |
| EVIDÊNCIA | OK: server/src/utils/errors.ts:92-120; server/src/config/env.ts:142, :329; .env.example:127,142-162; .env.staging.example:90-131; .env.production.example:252-254; conferenciaDaImplantacao.ts:85, :468-482. FALHA: server/src/services/integrations/AsaasHomologationService.ts:166-167 diz 'Configure DEVORA_PUBLIC_BASE_URL (ou ASAAS_WEBHOOK_PUBLIC_URL)'. O endereço real vem de GRUPO_SAMPAIO_PUBLIC_URL (server/src/services/core/AsaasWebhookInfo.ts:97-98). A mensagem é alcançável pela rota em server/src/routes/v1/core.ts:13916, e conferenciaDaImplantacao.ts:85 diz que a mesma variável 'nunca teve leitor'. |
| Veredito independente | PARCIAL (contraprova concorda) — contraprova: concorda (OPEN) |
| O que a reauditoria apontou | 1) server/src/services/integrations/AsaasHomologationService.ts:167: change the text to 'Configure GRUPO_SAMPAIO_PUBLIC_URL (ou ASAAS_WEBHOOK_PUBLIC_URL) com o endereço HTTPS público da API e reinicie.' That matches AsaasWebhookInfo.ts:137-138 and ProntidaoAsaasDoGrupo.ts:110. In server/tests/homologacao-asaas-cada-verde-executou.test.ts, the test at :219-225 should also assert that the message contains 'GRUPO_SAMPAIO_PUBLIC_URL' and does not contain 'DEVORA_PUBLIC_BASE_URL'. 2) Leftovers of the same removal, which the ficha's rule 'every documented key is read' also covers: in src/lib/api/asaasWebhook.ts:22 the frontend type still declares baseSource: 'ASAAS_WEBHOOK_PUBLIC_URL' \| 'DEVORA_PUBLIC_BASE_URL', but the server only returns 'GRUPO_SAMPAIO_PUBLIC_URL' (AsaasWebhookInfo.ts:52,98). Change it to 'GRUPO_SAMPAIO_PUBLIC_URL' and adjust the mocks in src/pages/gs/__tests__/integracaoAsaasWebhook.test.tsx:48,117,122. The beforeEach in homologacao-asaas-cada-verde-executou.test.ts:83/102/220 sets and deletes DEVORA_PUBLIC_BASE_URL, which has no effect. As a result the 'endereço local' test at :219 proves nothing by deleting it. It should use GRUPO_SAMPAIO_PUBLIC_URL. 3) Suggested guard: o-contrato-de-variaveis.test.ts only scans reads by AST (lidasPeloServidor, :81-117), not string literals. Add a case that fails if a key from the retired list (DEVORA_PUBLIC_BASE_URL) appears in a literal under server/src or src, outside conferenciaDaImplantacao.ts. |
| Correção depois da reauditoria | RESOLVED_PROVEN — A reauditoria (auditor DEP3 + contraprova) achou a mensagem da homologação do Asaas mandando configurar DEVORA_PUBLIC_BASE_URL, que nada lê, e o tipo da tela listando-a como origem do endereço. 6310793 troca a mensagem e o tipo pela variável que o servidor lê (GRUPO_SAMPAIO_PUBLIC_URL) e acrescenta a trava nome-aposentado-nao-volta (nenhum nome de VARIAVEIS_SEM_EFEITO no código do produto sem comentários, fora de quem avisa). Prova: Vermelho antes: a trava acusou AsaasHomologationService.ts e src/lib/api/asaasWebhook.ts. Verde em int/b depois da junção 615ca38: nome-aposentado-nao-volta, homologacao-asaas-cada-verde-executou, o-contrato-de-variaveis e a-conferencia-da-implantacao 60/60; integracaoAsaasWebhook.test.tsx 9/9. |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-154 — Artefatos legados versionados: server/backups/*.json (snapshots JSON do projeto anterior) apesar de .gitignore listar a pasta; server/data/devora-api.json; .env.bak-* com segredos na raiz (ignorado)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | n/a / DEP |
| ANTES | server/backups/*.json e saídas de execução eram versionados, server/data/devora-api.json era legado, e havia uma cópia .env.bak-* com segredos na raiz da instalação. |
| Causa | .gitignore de server/backups/ so vale para arquivo novo; dumps de execucao e extracoes comitados no snapshot inicial; nome de banco do sistema anterior nos exemplos e no default do esquema. |
| Correção | git rm dos 12 artefatos; .gitignore segura vitest-*.txt; exemplos e default de env.ts com o nome de sqlite.ts (staging igual ao compose); conferencia da implantacao ganha o item "Sobras do sistema anterior" (so pelo nome: .env.bak*/.env.backup* na raiz e em server/, server/data/*.json, server/backups/*.json) em ATENCAO com o que fazer; GO_LIVE_CHECKLIST cobra. |
| DEPOIS | git ls-files não traz nada de server/backups, devora-api.json, vitest-*.txt, cp37 nem .env.bak. O .gitignore segura .env.bak*, server/backups/ e vitest-*.txt. O banco padrão chama grupo-sampaio.db. A conferência dá ATENCAO pelo nome para cópia de .env, banco JSON antigo e backup JSON antigo, com o que fazer. O que resta é limpeza manual na máquina da loja; não falta código. |
| Arquivos | .gitignore, .env.example, .env.staging.example, server/src/config/env.ts, server/src/services/implantacao/conferenciaDaImplantacao.ts, server/tests/o-legado-sai-da-arvore.test.ts, docs/GO_LIVE_CHECKLIST.md |
| COMMIT | 00256a2 |
| TESTES | server/tests/o-legado-sai-da-arvore.test.ts: repositório sem dado nem sobra; .gitignore; exemplos e padrão do esquema sem .json; conferência ATENCAO pelo nome; .env.example e .env não contam como cópia. Rodado: verde. |
| EVIDÊNCIA | git ls-files server/backups server/data: só .gitkeep e backups/.gitignore; .gitignore:58-59,66,70; server/src/services/implantacao/conferenciaDaImplantacao.ts:448-466, :500-522 (sobrasDoLegado, sem abrir os arquivos); docs/GO_LIVE_CHECKLIST.md:34-35. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Na máquina da loja: guardar .env.bak-2026-08-27T13-42-14-753Z no cofre de senhas e apagá-lo da pasta; conferir e apagar server/data/devora-api.json e o que restar em server/backups/*.json. A conferência da implantação aponta cada um. Não abri a pasta da loja. |

### GAP-PRD-155 — IDOR: POST /asaas/queue/:attemptId/retry processa a tentativa Asaas de OUTRA empresa

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 — ajuste P2→P3 (fase 2) / SECURITY_RISK (após refutação: P3 / SECURITY_RISK) |
| Empresa / frente | Todas (qualquer gestor/admin de uma operação alcança as tentativas das outras cinco por id) / FIN |
| ANTES | A empresa B chamava POST /asaas/queue/<id de A>/retry e recebia 200 {status:'not_found'}. Mesmo assim a tentativa de A era processada com o cofre de A, e nada ficava auditado. |
| Causa | o processamento da fila legada nao recebia empresa; o id alheio era processado com o cofre alheio |
| Correção | processOperationalAttempt(attemptId, companyId): toda leitura e escrita cercada pela empresa, devolve a tentativa ou null. POST /asaas/queue/:attemptId/retry responde 404 ASAAS_ATTEMPT_NOT_FOUND para id alheio sem tocar nada, e audita asaas.queue.retry (antes/depois/erro, com o usuario) e asaas.queue.retry_denied. Homologacao e teste sandbox passam a empresa. |
| DEPOIS | A rota procura a tentativa só na lista da empresa do token. Id de outra empresa responde 404 ASAAS_ATTEMPT_NOT_FOUND sem tocar em nada e grava asaas.queue.retry_denied. O serviço também cerca pela empresa toda leitura e escrita, e devolve null para id alheio. O retry legítimo é auditado com o antes, o depois e o usuário. |
| Arquivos | server/src/services/asaas/AsaasOperationalService.ts, server/src/routes/v1/index.ts, server/src/services/integrations/AsaasHomologationService.ts, server/tests/asaas-rotas-legadas.test.ts, server/tests/asaas.sandbox.test.ts |
| COMMIT | 32caf1f |
| TESTES | server/tests/asaas-rotas-legadas.test.ts, bloco GAP-PRD-155 com 5 casos. Afirma: B com o id de A dá 404 e a tentativa de A continua queued, sem sanitizedError e com retryCount 0. O serviço devolve null para outra empresa. A reprocessando a própria tentativa dá 200 e 1 linha de auditoria com company_id, user_id e antes/depois. A recusa de B é auditada sem vazar estado. A listagem continua cercada pela empresa. Rodei: verde. |
| EVIDÊNCIA | server/src/routes/v1/index.ts:331-368; server/src/services/asaas/AsaasOperationalService.ts:77-79 (listagem por companyId) e :93-102 (daEmpresa = id E companyId em toda leitura e escrita); server/src/services/integrations/AsaasHomologationService.ts:459 passa a empresa. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-156 — Sem Content-Security-Policy nem HSTS (sem helmet) enquanto access e refresh token vivem em localStorage

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / SECURITY_RISK |
| Empresa / frente | Todas / INT |
| ANTES | A API mandava só nosniff, Referrer-Policy e X-Frame-Options. Não havia CSP nem HSTS em lugar nenhum, com access e refresh token no localStorage. |
| Causa | Defesa em profundidade ausente enquanto access e refresh token vivem no localStorage. |
| Correção | Servidor: middleware/cabecalhosDeSeguranca.ts como PRIMEIRO middleware — CSP de API (default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none') em toda resposta, inclusive /uploads, preflight, 429 e erro do parser; HSTS max-age=15552000 so quando req.secure (TLS no app ou X-Forwarded-Proto do proxy declarado; o do cliente nao vale). Tela: src/lib/seguranca/politicaDeConteudo.ts + plugin no vite.config.ts (so no build; o dev injeta script inline do React Refresh) poe a meta CSP no index.html antes de qualquer link/script: script-src 'self', connect-src a propria origem e a API (VITE_API_BASE_URL, ou a porta 8787 de qualquer host no modo LAN), img-src com a API/data:/blob:/https:, style-src com 'unsafe-inline' (as janelas de impressao e o srcdoc herdam a politica), object-src 'none', base-uri e form-action 'self'. DEPLOY.md: o que so o host estatico pode mandar (HSTS e frame-ancestors do index.html) com as linhas do nginx. |
| DEPOIS | O primeiro middleware manda a CSP de API (default-src 'none'; frame-ancestors 'none') em toda resposta, e HSTS de 180 dias só quando req.secure. O build injeta uma meta CSP no index.html (script-src 'self', connect-src só a origem e a API, object-src 'none'). As telas servidas pela API levam só frame-ancestors, object-src e base-uri. Os tokens continuam no localStorage por decisão registrada; o refresh roda a cada renovação (uso único) e o access dura 1 h. |
| Arquivos | server/src/middleware/cabecalhosDeSeguranca.ts, server/src/app.ts, src/lib/seguranca/politicaDeConteudo.ts, vite.config.ts, docs/DEPLOY.md, server/tests/cabecalhos-de-seguranca.test.ts, src/lib/seguranca/__tests__/politicaDeConteudo.test.ts, server/src/services/implantacao/frontendEstatico.ts, server/tests/a-api-serve-as-telas-com-fallback.test.ts |
| COMMIT | 7a07e54, d5b8e61 |
| TESTES | server/tests/cabecalhos-de-seguranca.test.ts (7 casos): CSP em JSON, /uploads, 404, erro do parser e preflight; sem HSTS em HTTP puro; HSTS atrás do proxy declarado; o X-Forwarded-Proto do cliente não liga HSTS. a-api-serve-as-telas-com-fallback: a tela não herda a CSP da API. Tela: politicaDeConteudo (10 casos). Rodei: verdes. O E2E citado no journal eu não refiz. |
| EVIDÊNCIA | server/src/middleware/cabecalhosDeSeguranca.ts:44-56; server/src/app.ts:89; src/lib/seguranca/politicaDeConteudo.ts:85-114; vite.config.ts:19-29, :74; server/src/services/implantacao/frontendEstatico.ts:101, :110; server/src/services/api/ApiAuthService.ts:181-183 (rotação do refresh); docs/DEPLOY.md:456-471. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Só quando o index.html é entregue por um host estático ou proxy separado da API: adicionar Strict-Transport-Security e Content-Security-Policy: frame-ancestors 'none' (linhas nginx prontas em docs/DEPLOY.md:467-471). Com DEVORA_SERVIR_FRONTEND=true a própria API já manda os dois. |

### GAP-PRD-157 — JSON malformado no corpo responde 500 'Erro interno' e é registrado como unhandled_error com pilha

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | Todas / SEG |
| ANTES | Um JSON malformado no corpo respondia 500 'Erro interno' e era logado como unhandled_error com pilha. |
| Causa | Os erros do body-parser (entity.parse.failed, entity.too.large, charset/encoding) caiam no ramo generico de 500, e o X-Request-Id era montado depois dos parsers. |
| Correção | middleware/erroDoCorpo.ts traduz SO os erros do body-parser (pelo type do http-errors, nao por instanceof SyntaxError, que tambem e o de um JSON.parse corrompido do banco): 400 API_INVALID_PAYLOAD, 413 API_PAYLOAD_TOO_LARGE com o teto da rota, 415 API_UNSUPPORTED_MEDIA_TYPE, 400 API_REQUEST_ABORTED; 5xx do parser segue 500. O tratador de app.ts os passa pelo caminho de toda recusa (envelope, requestId, api_request_logs). O middleware de X-Request-Id passou para antes dos parsers. |
| DEPOIS | Os erros do body-parser, identificados pelo campo type do http-errors, viram ApiError: 400 API_INVALID_PAYLOAD, 413 API_PAYLOAD_TOO_LARGE com o teto da rota, 415, e 400 para corpo abortado. Seguem o caminho de toda recusa (envelope, requestId, api_request_logs). Um SyntaxError interno continua 500. O X-Request-Id nasce antes dos parsers. |
| Arquivos | server/src/middleware/erroDoCorpo.ts, server/src/app.ts, server/tests/corpo-malformado-nao-e-erro-interno.test.ts |
| COMMIT | 35bb4e7 |
| TESTES | server/tests/corpo-malformado-nao-e-erro-interno.test.ts (8 casos): 400 com envelope; o correlationId volta; a recusa entra em api_request_logs; vale antes da autenticação; 413 com teto de 1 MB; a rota de 8 MB aceita; exceção comum segue 500; charset desconhecido dá 415. Rodei: verde. |
| EVIDÊNCIA | server/src/middleware/erroDoCorpo.ts:42-112; server/src/app.ts:132-140 (id antes dos parsers), :315-335 (tradução e envelope). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-158 — window.prompt/confirm em operações que mudam dinheiro e estoque (cancelar nota de entrada, inventário, locação, pedido de compra, expedição, devolução de pedido, unidade serializada)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / INT |
| ANTES | Cancelar nota de entrada, inventário, locação, pedido de compra, expedição, devolução com estorno e unidade serializada pediam motivo ou certeza por window.prompt/confirm. Não havia validação, nem tamanho mínimo, e o diálogo bloqueava a aba. |
| Causa | Não havia pergunta de motivo/confirmação da casa: cada tela recorria ao diálogo do navegador, sem validação, sem tamanho mínimo e bloqueante. |
| Correção | PerguntaDaTela (usePedirMotivo/useConfirmar) sobre DialogoBase e DialogoDeMotivo: o tamanho mínimo é conferido no próprio diálogo antes de o servidor ser chamado, o motivo é opcional só onde o servidor aceita em branco, e a confirmação começa com o foco em Cancelar (Enter por reflexo não confirma o que não se leu). Telas da base convertidas em 2ceb03f; as cinco perguntas da loja online em c85d490 (cancelar exige motivo como o servidor; desfazer etapa e recusar devolução exigem 5 caracteres; aprovar e devolver aceitam em branco; "a mercadoria voltou?" começa em "Ainda não voltou"). Trava de regressão em 59a8962. |
| DEPOIS | Nenhuma chamada nativa sobra em src/: o grep por prompt(/confirm(/alert( só acha comentários e uma função local chamada confirm. As telas perguntam por usePedirMotivo/useConfirmar, que usam DialogoBase. O mínimo é conferido no diálogo, com erro role=alert e aria-invalid no campo, e é o mesmo do servidor. Na confirmação o foco começa em Cancelar. |
| Arquivos | src/components/gs/AcoesDoPedido.tsx, src/components/gs/DialogoBase.tsx, src/components/gs/DialogoDeMotivo.tsx, src/components/gs/FotosDoEquipamentoCard.tsx, src/components/gs/PerguntaDaTela.tsx, src/components/gs/SolicitacoesDeDevolucao.tsx, src/components/gs/__tests__/acoesDoPedido.test.tsx, src/components/gs/__tests__/devolucaoDoPedido.test.tsx, src/components/gs/__tests__/dialogoPrendeOFoco.test.tsx, src/components/gs/__tests__/perguntaDaTela.test.tsx, src/components/gs/__tests__/posVendaDoPortal.test.tsx, src/components/gs/__tests__/semDialogoDoNavegador.test.ts, src/components/gs/armadilhaDeFoco.ts, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/InventarioPage.tsx, src/pages/gs/LeadsPage.tsx, src/pages/gs/LocacaoPage.tsx, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/PedidosCompraPage.tsx, src/pages/gs/UnidadesEstoquePage.tsx, src/pages/gs/__tests__/entradaManualEEstorno.test.tsx, src/pages/gs/__tests__/identidadeDoEquipamento.test.tsx, src/pages/gs/__tests__/pedidosCancelarEDesfazer.test.tsx |
| COMMIT | 7b89ae7, 2ceb03f, 59a8962, c85d490 |
| TESTES | Rodei 7 arquivos de tela: 42/42 verdes. semDialogoDoNavegador.test.ts varre todo src/ sem comentários, exige mais de 100 fontes lidas e nenhuma chamada nativa, com a lista de exceções vazia. perguntaDaTela.test.tsx: motivo curto recusado na tela, com alert e aria-invalid e sem chamar quem pediu; motivo volta aparado; desistir volta null; confirmação começa em Cancelar. pedidosCancelarEDesfazer.test.tsx: cancelar e desfazer etapa respondidos por role=dialog com o nome. Também verdes: acoesDoPedido, devolucaoDoPedido, entradaManualEEstorno e dialogoPrendeOFoco. Não rodei posVendaDoPortal, identidadeDoEquipamento, PedidosPage e MinhaContaPage; confirmei que os arquivos existem. |
| EVIDÊNCIA | src/components/gs/PerguntaDaTela.tsx:31-128 (usePedirMotivo; useConfirmar com focoInicial em Cancelar :107-111); src/components/gs/DialogoDeMotivo.tsx:33-43 (trim + mínimo) e :86-93 (erro role=alert). Mínimos: EntradaNotasPage.tsx:1011-1015 (3) = server NfeImportService.ts:2637 (3); InventarioPage.tsx:241-245 (3) = InventoryCountService.ts:326/466; LocacaoPage.tsx:145-149 (3) = RentalContractService.ts:259; PedidosCompraPage.tsx:389-392 (3) = PurchaseOrderService.ts:238. UnidadesEstoquePage.tsx:292-299 (baixa, mínimo 1) = core.ts:11743-11745. A divergência de identidade virou bloco na tela (:354). LeadsPage.tsx:124/178. Expedição: GestaoPages.tsx:542-545 abre o formulário DespachoDoPedido, não usa prompt. Devolução com estorno: AcoesDoPedido.tsx:100-120, com o total no título e a pergunta da mercadoria começando em 'Ainda não voltou'. Cancelar e desfazer etapa: AcoesDoPedido.tsx:44-51 e :154-160. Trava: semDialogoDoNavegador.test.ts:27 (AINDA_NA_JUNCAO = {}) e :29 (regex window.(prompt\|confirm\|alert)(). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-159 — Diálogos sem armadilha de foco e sem devolução do foco ao fechar; suíte de acessibilidade básica no resto está de pé

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / INT |
| ANTES | Os modais (CaixaPdvDialog, PagamentoDialog, ClientePdvDialog, PesquisaAvancadaDialog e outros) tinham role=dialog aria-modal, mas não prendiam o Tab. Ao fechar, o foco ia para o body. |
| Causa | Cada moldura era desenhada à mão, sem um componente de diálogo com armadilha de foco. |
| Correção | armadilhaDeFoco.ts: instalarArmadilhaDeFoco/useArmadilhaDeFoco/prenderFoco (callback ref do React 19), com o ouvinte no DOCUMENTO (Tab e Shift+Tab giram dentro, o foco que escapa volta), a pilha de diálogos (só o de cima prende; estaNoTopo deixa o Esc fechar só ele) e a devolução do foco a quem abriu. DialogoBase com aria-labelledby, Esc e ×. Molduras da base em 82c7ec7; as onze da PAG (PDV, maquininha, caixa, devoluções, terminais, conferência, regularização) em 5364264; a "Minha conta" trocou a armadilha própria pela da casa em c85d490, guardando só o que é dela (Esc não fecha com o cancelamento em voo; foco ao título do pedido quando o botão que abriu desmontou). |
| DEPOIS | armadilhaDeFoco.ts prende o foco com ouvinte no documento: Tab e Shift+Tab giram dentro, o foco que escapa volta, e uma pilha faz só o diálogo de cima prender. Ao fechar, o foco volta a quem abriu. Todos os 23 modais aria-modal de src/ usam ref={prenderFoco} no próprio elemento, ou DialogoBase, ou useArmadilhaDeFoco (MinhaConta). Isso inclui os dois modais de PdvPage e os dois de OperacaoPages. DialogoBase nomeia por aria-labelledby. Os quatro diálogos da ficha têm nome acessível por aria-label, não aria-labelledby, e o leitor de tela anuncia o nome do mesmo jeito. |
| Arquivos | src/components/gs/AbrirOsDialog.tsx, src/components/gs/AcoesDoPedido.tsx, src/components/gs/CaixaPdvDialog.tsx, src/components/gs/ClientePdvDialog.tsx, src/components/gs/DialogoBase.tsx, src/components/gs/DialogoDeMotivo.tsx, src/components/gs/DireitosDoTitular.tsx, src/components/gs/EstornoOsDialog.tsx, src/components/gs/MaquininhasIntegradasCard.tsx, src/components/gs/OsAReceberDialog.tsx, src/components/gs/PagamentoDialog.tsx, src/components/gs/PendenciasDaMaquininhaCard.tsx, src/components/gs/PerguntaDaTela.tsx, src/components/gs/PesquisaAvancadaDialog.tsx, src/components/gs/RecebimentoOsDialog.tsx, src/components/gs/RegularizarVendasOffline.tsx, src/components/gs/SolicitacoesDeDevolucao.tsx, src/components/gs/__tests__/acoesDoPedido.test.tsx, src/components/gs/__tests__/devolucaoDoPedido.test.tsx, src/components/gs/__tests__/dialogoPrendeOFoco.test.tsx, src/components/gs/__tests__/perguntaDaTela.test.tsx, src/components/gs/__tests__/posVendaDoPortal.test.tsx, src/components/gs/__tests__/semDialogoDoNavegador.test.ts, src/components/gs/armadilhaDeFoco.ts, src/pages/gs/CategoriasMarcasPage.tsx, src/pages/gs/ConferenciaMaquininhaPage.tsx, src/pages/gs/ConsignacoesPage.tsx, src/pages/gs/DevolucoesPage.tsx, src/pages/gs/ImpressorasPage.tsx, src/pages/gs/MaquininhasPage.tsx, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/OperacaoPages.tsx, src/pages/gs/OrcamentosPage.tsx, src/pages/gs/OrdemServicoPage.tsx, src/pages/gs/PdvPage.tsx, src/pages/gs/TerminaisPage.tsx, src/pages/gs/__tests__/pedidosCancelarEDesfazer.test.tsx |
| COMMIT | 7b89ae7, 82c7ec7, 5364264, 59a8962, c85d490 |
| TESTES | Rodei dialogoPrendeOFoco.test.tsx, verde. Ele afirma: nome por aria-labelledby e aria-modal; o foco entra no campo marcado; Tab no último vai ao primeiro e Shift+Tab volta; o foco que escapa para a tela de trás volta; Esc devolve o foco ao gatilho; diálogo aninhado, só o de cima prende e fecha. Afirma também que prenderFoco numa moldura própria entra, gira e devolve, e que o EstornoOsDialog real recebe o foco. semDialogoDoNavegador.test.ts, verde, reprova arquivo com role=dialog + aria-modal=true sem prenderFoco/useArmadilhaDeFoco/DialogoBase. Essa checagem é por arquivo; conferi a mão que cada modal tem a sua. Total da rodada: 7 arquivos, 42/42 verdes; git status continuou limpo. |
| EVIDÊNCIA | src/components/gs/armadilhaDeFoco.ts:58-103 (entrada do foco :62-66, giro do Tab :68-87, focusin que devolve o foco :88-91, pilha e devolução a quem abriu :98-101) e :122-125 (prenderFoco). DialogoBase.tsx:59 (useArmadilhaDeFoco), :79 (aria-labelledby), :63-64 (Esc só no topo). Os quatro da ficha: CaixaPdvDialog.tsx:487-491, PagamentoDialog.tsx:211-215, ClientePdvDialog.tsx:192-196 e PesquisaAvancadaDialog.tsx:111-115, todos com ref={prenderFoco} e aria-label. PdvPage.tsx:3663/3745; OperacaoPages.tsx:1141/2201; MinhaContaPage.tsx:968/1385-1388. Os role=dialog sem aria-modal são painéis não modais: FiscalBadgePdv.tsx:126 (popover) e PlaquinhasPage.tsx:770 (aria-modal=false). Os alertdialog são blocos em linha, ou ficam dentro de um diálogo que já prende o foco. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-160 — ERP sem 'esqueci minha senha' para funcionários: só a gestão redefine (senha provisória); o dono decide se isso basta

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / SEG |
| ANTES | Não havia 'esqueci minha senha' para funcionários. Só a gestão redefinia a senha. |
| Causa | O unico canal era a gestao; faltava o mecanismo para o dono poder escolher o outro. |
| Correção | Mecanismo completo com padrao seguro (DESLIGADO por operacao): RecuperacaoDeSenhaDaEquipe (codigo de 8 digitos, uso unico, 15 min, 5 tentativas, HMAC; conta so recupera se ligada em TODAS as suas operacoes; contas de dono nunca; 3 pedidos/hora por conta e 10 por origem; resposta sempre igual; troca derruba sessoes, limpa bloqueio, avisa o e-mail e fica na trilha). Rotas publicas /auth/senha/recuperacao, /esqueci, /recuperar; do dono GET/PUT /core/team/recuperacao-de-senha. Tabelas novas na DDL canonica. A fila de e-mail listada oculta o corpo de recuperacao_senha e recuperacao_senha_equipe. Telas: "Esqueci minha senha" no login so quando alguma operacao ligou e ha SMTP; cartao do dono em Usuarios e equipe com o estado do SMTP. |
| DEPOIS | As duas opções estão implementadas; a escolha é só configuração. Desligado (padrão, por operação) mantém a gestão como único canal. Ligado, há código de 8 dígitos de uso único por 15 min, 5 tentativas, HMAC, limite por conta e por origem, e resposta sempre igual. Contas de dono ficam fora. Só recupera quem está ligado em todas as operações. A troca derruba sessões, grava auditoria e avisa por e-mail. A tela de login só mostra o link com operação ligada e SMTP pronto. |
| Arquivos | server/src/services/auth/RecuperacaoDeSenhaDaEquipe.ts, server/src/db/schema.ts, server/src/routes/v1/auth.ts, server/src/routes/v1/core.ts, server/src/services/notifications/EmailService.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/recuperacaoDeSenha.ts, src/components/gs/EsqueciMinhaSenha.tsx, src/components/gs/RecuperacaoDeSenhaDaOperacao.tsx, src/pages/gs/LoginPage.tsx, src/pages/gs/EquipePage.tsx, server/tests/esqueci-minha-senha-da-equipe.test.ts, src/components/gs/__tests__/esqueciMinhaSenha.test.tsx, src/components/gs/__tests__/recuperacaoDeSenhaDaOperacao.test.tsx, docs/audits/remediacao/migracoes/SEG.md |
| COMMIT | 8349fa1, 4f7e0f1 |
| TESTES | server/tests/esqueci-minha-senha-da-equipe.test.ts (17 casos): desligado não enfileira; login sem o link; o código troca a senha, derruba a sessão e vale uma vez; 5 erros queimam o código; vencido recusado; resposta igual para conta inexistente; conta de dono excluída; desligar depois do pedido invalida; a fila oculta o código; gerente toma 403 e gestor liga com trilha; 'disponível' depende do SMTP. Tela: esqueciMinhaSenha (4), recuperacaoDeSenhaDaOperacao (3). Rodei: verdes. |
| EVIDÊNCIA | Entrada da decisão: src/pages/gs/EquipePage.tsx:193 (cartão RecuperacaoDeSenhaDaOperacao) chama PUT /core/team/recuperacao-de-senha em server/src/routes/v1/core.ts:9296-9316 (só dono, auditoria). SMTP: .env.production.example:227-229 e server/src/config/env.ts:273-275. E-mail do funcionário: EquipePage.tsx:729-733. Uso de ponta a ponta: src/components/gs/EsqueciMinhaSenha.tsx:33-55; server/src/routes/v1/auth.ts:747-780; server/src/services/auth/RecuperacaoDeSenhaDaEquipe.ts:128-141, :199-207, :229-303, :313-379; server/src/services/notifications/EmailService.ts:1051-1079. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel decide, por operação, se liga a recuperação por e-mail (em Usuários e equipe; o padrão é desligado, e desligado já é o modelo atual). Se ligar: configurar EMAIL_ENABLED, EMAIL_FROM, EMAIL_SMTP_HOST/USER/PASSWORD e cadastrar o e-mail de cada funcionário. |

### GAP-PRD-161 — Devolução em dinheiro apontando caixa fechado (ou sem caixa) grava a devolução sem movimento de gaveta, em silêncio

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 — ajuste P2→P3 (fase 2) / DATA_INTEGRITY_RISK (após refutação: P3 / DATA_INTEGRITY_RISK) |
| Empresa / frente | Todas / PAG |
| ANTES | Devolução em dinheiro com caixa fechado, ou sem caixa, gravava a devolução e a despesa sem movimento de gaveta, em silêncio. |
| Causa | A devolucao so lancava movimento com a gaveta informada e aberta, e se calava no resto; cada porta de especie tinha a propria regua. |
| Correção | GavetaDoDinheiro.gavetaDoDinheiro, regua unica: a informada se desta operacao e aberta (outra operacao: 400 CORE_CASH_SESSION_INVALID); fechada ou ausente -> gaveta aberta do caixa do pedido (corpo ou token, conferido por TerminalRegistry), senao a unica aberta; varias sem caixa no pedido, ou nenhuma -> 409 CORE_CASH_SESSION_REQUIRED com o valor e o que fazer, antes de gravar (a transacao desfaz devolucao, estoque e financeiro). core_sale_returns.cash_session_id grava a gaveta de onde o dinheiro SAIU; a nota do movimento diz "turno ja fechado". POST /sale-returns e POST /sales/:id/cancel passam o caixa do pedido (terminalDoPedido); cancelSale usa a mesma regua (fecha a dependencia registrada no GAP-PRD-039). Tela de Devolucoes consulta a gaveta com o caixa guardado neste computador, manda terminalId, explica quando a operacao tem caixas e o computador nao escolheu, e o cancelamento leva o caixa. |
| DEPOIS | createSaleReturn usa gavetaDoDinheiro: a informada se aberta e desta operação (de outra operação dá 400). Fechada ou ausente, usa a gaveta de agora do caixa do pedido ou a única aberta, e a nota diz 'turno já fechado'. Se não há nenhuma, responde 409 CORE_CASH_SESSION_REQUIRED antes do commit, e a transação desfaz tudo. A tela manda o caixa do computador. Mesma exceção declarada da operação que nunca abriu gaveta. |
| Arquivos | server/src/services/core/GavetaDoDinheiro.ts, server/src/services/core/SaleReturnService.ts, server/src/services/core/SalesService.ts, server/src/routes/v1/core.ts, server/tests/dinheiro-so-com-gaveta.test.ts, src/lib/api/core.ts, src/pages/gs/DevolucoesPage.tsx, src/pages/gs/__tests__/devolucaoDevolveOQueEntrou.test.tsx |
| COMMIT | 96fcb09, 089fc5e |
| TESTES | server/tests/dinheiro-so-com-gaveta.test.ts:317-510. Afirma: com a gaveta fechada, o dinheiro sai da aberta de hoje, com nota; fechada e nenhuma aberta dá 409 sem gravar nada; sem id e com caixa aberto, sai dele; gaveta de outra operação dá 400; PIX, cartão e crédito não passam pela gaveta; com dois caixas, sai do caixa do pedido; cancelar depois de devolver não debita duas vezes. Tela: devolucaoDevolveOQueEntrou.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/SaleReturnService.ts:529-550; GavetaDoDinheiro.ts:111-220; routes/v1/core.ts:15024-15027 (terminalId do pedido); src/pages/gs/DevolucoesPage.tsx:616. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-162 — Recibo e reimpressão de transação de maquininha respondem 200 com objeto fabricado, inclusive para id inexistente

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / PAG |
| ANTES | GET /receipt e POST /reprint respondiam 200 com objeto fabricado, até para id inexistente e sem conferir a empresa. |
| Causa | As rotas montavam um objeto na hora sem consultar transacao, empresa ou comprovante; o texto que a adquirente devolvia na cobranca era descartado. |
| Correção | guardarComprovante grava em payment_terminal_receipts as vias do estabelecimento e do cliente devolvidas pelo adaptador no momento da cobranca (o mock marca no proprio texto que e SIMULADO); getPaymentTerminalReceiptBackend/reprintPaymentTerminalReceiptBackend com cerca por empresa: 404 PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND para id inexistente ou alheio, 404 PAYMENT_TERMINAL_RECEIPT_NOT_AVAILABLE quando a cobranca nao tem comprovante, ?via=merchant\|customer (400 para outra), reimpressao devolve o MESMO texto com reprintCount, historico e auditoria. |
| DEPOIS | As rotas leem payment_terminal_receipts, gravado no momento da cobrança, sempre presas à empresa do token. Id inexistente ou alheio dá 404 PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND; sem comprovante guardado dá 404 RECEIPT_NOT_AVAILABLE; via inválida dá 400. A reimpressão devolve o mesmo texto, conta as vias e grava histórico e auditoria. |
| Arquivos | server/src/routes/v1/payment-terminals.ts, server/src/services/payment-terminal/PaymentTerminalService.ts, server/src/services/payment-terminal/PaymentTerminalProviderAdapter.ts, server/tests/maquininha-estorno-e-comprovante-honestos.test.ts |
| COMMIT | 25fce09 |
| TESTES | server/tests/maquininha-estorno-e-comprovante-honestos.test.ts:273-352. Afirma: 404 para id inexistente nas duas rotas; 404 para outra empresa; o texto guardado traz o valor; via customer funciona; RECEIPT_NOT_AVAILABLE para cobrança recusada; a reimpressão devolve o mesmo texto com reprintCount 1 e 2 e dois registros no histórico. Rodei: verde. |
| EVIDÊNCIA | server/src/routes/v1/payment-terminals.ts:530-553; server/src/services/payment-terminal/PaymentTerminalService.ts:1448-1529 e :880 (guardarComprovante na cobrança); PaymentTerminalTransactionEffects.ts:64. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-163 — NFC-e não é emitida no Finalizar: é botão manual no painel fiscal pós-venda

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / FIS |
| ANTES | A NFC-e não saía no Finalizar. Era um botão manual no painel fiscal depois da venda, e não havia como escolher. |
| Causa | Escolha de comportamento (automatica x manual) sem mecanismo. |
| Correção | core_fiscal_emission_policies (MANUAL, padrao seguro = comportamento atual; AUTOMATICA); GET /core/fiscal/emission-policy (gerencia) e PUT (so donos, 400 fora da lista, trilha fiscal.emission_policy_updated). EmissaoNoFinalizar.emitirNoFinalizar: no modo automatico, POST /core/sales e a conversao de pre-venda disparam a emissao em segundo plano (setImmediate, depois da resposta) so quando emissionReadinessForSale esta verde - a mesma regua do botao; a resposta traz nfceNoFinalizar {modo, disparada, motivos}; a falha vira trilha fiscal.nfce_auto_emit_failed e nunca derruba a venda; a venda repetida pela mesma chave nao dispara de novo; emitNfceForSale segue idempotente por venda. O emissor de teste e recusado em producao (NODE_ENV ou DEVORA_API_ENV) e ignorado se armado antes. Tela: cartao 'NFC-e no Finalizar' em Fiscal > Configuracao; o painel do PDV diz que a nota esta saindo sozinha (sem o botao de emitir de novo) ou por que a automatica nao saiu. |
| DEPOIS | Os dois modos existem (MANUAL por padrão, AUTOMATICA) e só os donos gravam, pelo PUT. No automático, POST /core/sales e a conversão de pré-venda disparam a emissão com setImmediate, só se emissionReadinessForSale estiver verde. A falha vira trilha e não derruba a venda; a venda repetida não dispara de novo. O emissor de teste é recusado em produção. O cartão fica em Fiscal > Configuração, e o painel do PDV lê nfceNoFinalizar. |
| Arquivos | server/src/services/core/EmissaoNoFinalizar.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/nfce-no-finalizar.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/EmissaoNoFinalizarCard.tsx, src/lib/api/emissaoNoFinalizar.ts, src/pages/gs/FiscalPage.tsx, src/pages/gs/PdvPage.tsx, src/components/gs/PainelFiscalPdv.tsx, src/components/gs/__tests__/emissaoNoFinalizarNaTela.test.tsx |
| COMMIT | 126d9ae |
| TESTES | server/tests/nfce-no-finalizar.test.ts (12): padrão MANUAL; a gerência leva 403 e o dono grava com trilha; valor fora da lista é recusado; o automático dispara com a venda certa; sem certificado não dispara e diz por quê; a falha não derruba a venda; a venda repetida não redispara; NODE_ENV e DEVORA_API_ENV production recusam o emissor de teste. Rodei: verde. Tela: emissaoNoFinalizarNaTela.test.tsx, verde. |
| EVIDÊNCIA | server/src/services/core/EmissaoNoFinalizar.ts:43-45, :63-90, :134-148, :167-216; core.ts:8085-8099 (GET gerência, PUT só donos), :5095-5096 (pré-venda), :5597-5602 (venda, sem disparo quando duplicated); src/pages/gs/FiscalPage.tsx:157 (EmissaoNoFinalizarCard); src/pages/gs/PdvPage.tsx:1740. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel: escolher MANUAL ou AUTOMATICA no cartão 'NFC-e no Finalizar' (Fiscal > Configuração). |

### GAP-PRD-164 — Listas com teto silencioso e sem paginação: notas de entrada (200), pedidos de compra (200), estoque baixo do painel (10)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas (cresce com o tempo) / EST |
| ANTES | As notas de entrada e os pedidos de compra cortavam em 200 sem offset nem total. O painel mostrava 10 produtos abaixo do mínimo sem dizer quantos existiam. |
| Causa | LIMIT fixo sem offset/total nas duas listas e corte do cartao do painel sem dizer quantos ficaram de fora |
| Correção | servidor: listNotes/countNotes com limit/offset, ?id= (a nota do link) e ?search= (numero, chave de acesso, fornecedor), ordem com desempate por id; listPurchaseOrders/countPurchaseOrders com limit/offset e filtros; /purchases/notes e /purchase-orders devolvem {items,total,limit,offset}; /dashboard devolve lowStockTotal. tela: Entrada de Notas com busca, rodape de pagina e a nota aberta fora da pagina pedida por ?id= (a ficha nao perde especie/status/fornecedor); Pedidos de compra com rodape de pagina; Painel diz 'N produtos abaixo do minimo (mostrando 10)' com link para a Central ja no relatorio 'minimo' (so para quem abre a Central); RelatoriosPage aceita ?relatorio= |
| DEPOIS | /purchases/notes (com ?id= e ?search=) e /purchase-orders devolvem {items,total,limit,offset}, e as telas têm rodapé de página. /dashboard devolve lowStockTotal e o painel diz 'N produtos abaixo do mínimo (mostrando 10)', com link para a Central. |
| Arquivos | server/src/services/core/NfeImportService.ts, server/src/services/core/PurchaseOrderService.ts, server/src/services/core/paginacao.ts, server/src/routes/v1/core.ts, server/tests/paginacao-das-listas.test.ts, src/lib/api/paginas.ts, src/lib/api/core.ts, src/components/gs/Paginacao.tsx, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/PedidosCompraPage.tsx, src/pages/gs/PainelPage.tsx, src/pages/gs/RelatoriosPage.tsx, src/pages/gs/__tests__/listasDizemQueCortaram.test.tsx |
| COMMIT | c31c36c, bd12f7f |
| TESTES | server/tests/paginacao-das-listas.test.ts:278-364 (205 notas: total 205, segunda página, ?id= fora da página, busca, isolamento; 205 pedidos; 12 abaixo do mínimo com lowStockTotal 12). src/pages/gs/__tests__/listasDizemQueCortaram.test.tsx:464-530. Rodado: verde. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:12367-12370 (notes), :14723-14726 (purchase-orders), :7114 (lowStockTotal); src/pages/gs/EntradaNotasPage.tsx:2171; src/pages/gs/PedidosCompraPage.tsx:871; src/pages/gs/PainelPage.tsx:20-27, 385-387 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-165 — Painel (faturamento, ticket, recebíveis em aberto) e posição de estoque com custo abertos a atendente e estoquista

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / EST |
| ANTES | O painel (faturamento, ticket, recebíveis) e a posição de estoque com custo abriam para atendente e estoquista por decisão tomada no código. |
| Causa | a decisao de quem le dinheiro estava tomada no codigo, sem mecanismo para o dono |
| Correção | tabela nova core_management_policies e PoliticaDeGestaoService com padrao SEGURO (so gerencia ve dinheiro); /dashboard tira faturamento, ticket, recebiveis e valores por dia/vendedor/produto/marca (dinheiroOculto) e /stock e /stock/valuation tiram custo e valor (custoOculto/oculto) no servidor para atendente/estoquista fora da politica; GET /management-policy (escritorio) e PUT (so donos) com trilha antes/depois; tela Configuracoes > Politica de gestao; painel e posicao dizem por que o dinheiro nao aparece; PainelPage deixa de estourar sem lowStock (toda-tela-monta) |
| DEPOIS | Existe política por empresa com padrão seguro: só a gerência vê. O servidor tira o dinheiro de /dashboard e o custo/valor de /stock e /stock/valuation para quem está fora da política. PUT /management-policy é só dos donos (admin_geral/gestor), com trilha antes/depois, e a tela fica em Configurações > Política de gestão. As duas opções já existem; a escolha é só configuração. |
| Arquivos | server/src/services/core/PoliticaDeGestaoService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/politica-de-gestao.test.ts, src/pages/gs/PoliticaGestaoPage.tsx, src/lib/api/politicaGestao.ts, src/pages/gs/PainelPage.tsx, src/pages/gs/OperacaoPages.tsx, src/lib/api/core.ts, src/router/gsRoutes.tsx, src/components/gs/navItems.ts, src/pages/gs/__tests__/politicaDeGestaoNaTela.test.tsx |
| COMMIT | 2521495 |
| TESTES | server/tests/politica-de-gestao.test.ts:77-170 (atendente sem faturamento/ticket/recebíveis, estoquista sem custo, dono abre com trilha, gerente não decide, outra empresa no padrão). src/pages/gs/__tests__/politicaDeGestaoNaTela.test.tsx:99-185. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/PoliticaDeGestaoService.ts:59-68 (padrão), :159-171 (veDinheiroDoPainel/veCustoDoEstoque); server/src/routes/v1/core.ts:2842-2849, :2885-2888, :7093-7114, :2923-2972; :930-935 (requireProfile sem lista = só admin_geral/gestor); src/router/gsRoutes.tsx:382 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel confirma na tela se atendente e estoquista veem o dinheiro do painel e o custo do estoque (padrão: não veem). |

### GAP-PRD-166 — Valor do estoque por custo do CADASTRO (último custo), não custo médio ponderado; CMV por custo fotografado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / EST |
| ANTES | O valor do estoque era sempre saldo × custo do cadastro (último custo), sem alternativa e sem registro da confirmação do contador. |
| Causa | a regua de valorizacao era decisao do codigo; o contador pode exigir custo medio |
| Correção | regua por empresa na politica de gestao: ultimo_custo (padrao, a de sempre) ou custo_medio (media movel reconstruida do razao: entradas com unit_cost_cents ponderam o saldo anterior; saidas, transferencias e devolucoes nao mudam a media; sem entrada com custo cai no cadastro e conta em semCustoNoRazao); listStock e stockValuation aplicam a regua, entao posicao, painel e Central (valorizacao, caveat reescrita) usam a mesma conta; confirmacao do contador (nome e data) registrada e derrubada ao trocar de regua; tela mostra a regua e a pendencia do contador |
| DEPOIS | As duas réguas estão implementadas: ultimo_custo (padrão) e custo_medio (média móvel reconstruída do razão). Posição, valuation e o relatório 'valorizacao' da Central aplicam a mesma régua. A confirmação do contador (nome e data) é registrada e cai quando a régua muda. A escolha é só configuração. |
| Arquivos | server/src/services/core/PoliticaDeGestaoService.ts, server/src/services/core/InventoryService.ts, server/src/services/core/ReportsService.ts, server/src/routes/v1/core.ts, server/tests/politica-de-gestao.test.ts, src/pages/gs/PoliticaGestaoPage.tsx, src/pages/gs/OperacaoPages.tsx, src/pages/gs/__tests__/politicaDeGestaoNaTela.test.tsx |
| COMMIT | 2521495 |
| TESTES | server/tests/politica-de-gestao.test.ts:172-230 (último custo × custo médio 40000/30000/22500, produto sem custo no razão contado, confirmação derrubada ao trocar). politicaDeGestaoNaTela.test.tsx:163-185. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/PoliticaDeGestaoService.ts:106-127 (troca derruba confirmação), :191-233 (custoMedioPorProduto), :248-273 (aplicarRegua); server/src/services/core/InventoryService.ts:1373-1390, :1448; server/src/services/core/ReportsService.ts:552-580; server/src/routes/v1/core.ts:2876-2883 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | O contador confirma a régua (último custo ou custo médio), e o dono a registra na tela com o nome dele. |

### GAP-PRD-167 — Inventário é por empresa (sem recorte por local de estoque) e não acerta serializado por diferença

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Preço Justo (2 locais), qualquer loja que use locais / EST |
| ANTES | A contagem comparava com o saldo total da empresa. Não havia recorte por local de estoque. |
| Causa | a contagem nao tinha dimensao de local, embora o saldo por local ja existisse no razao |
| Correção | coluna nova anulavel core_inventory_counts.location_id; openInventoryCount valida o local ativo da empresa e congela o saldo DAQUELE local (balanceByLocation), recordCount idem; applyInventoryCount movimenta no local contado e recusa deixar o local negativo alem do total; ficha e lista com location_code/location_name; trilha com o local; tela: seletor Local contado quando ha mais de um local ativo, selo e coluna Local |
| DEPOIS | core_inventory_counts.location_id é opcional. A abertura valida que o local está ativo e é da empresa, o esperado vira o saldo daquele local, e o acerto sai no local contado e recusa deixar o local negativo. A tela tem o seletor 'Local contado'. Serializado continua peça a peça, como decisão documentada. |
| Arquivos | server/src/services/core/InventoryCountService.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/inventario-por-local.test.ts, src/pages/gs/InventarioPage.tsx, src/lib/api/core.ts, src/pages/gs/__tests__/inventarioPorLocalNaTela.test.tsx, docs/audits/remediacao/migracoes/EST.md |
| COMMIT | 8c4773b |
| TESTES | server/tests/inventario-por-local.test.ts:64-120 (esperado da Vitrine e acerto na Vitrine, sem local = empresa, local não fica negativo, local inativo ou de outra empresa recusado). src/pages/gs/__tests__/inventarioPorLocalNaTela.test.tsx:102-135. Rodado: verde. |
| EVIDÊNCIA | server/src/services/core/InventoryCountService.ts:59-63 (saldoContado por local), :124-140 (validação do local), :197-200, :347-380 (recusa local negativo), :443 (locationId no acerto); server/src/db/schema.ts:1045; src/pages/gs/InventarioPage.tsx:189, 340 |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-168 — XML por e-mail (IMAP) e DF-e/manifestação dependem de insumos externos — o código está ligado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / EXTERNAL_CONFIGURATION_REQUIRED |
| Empresa / frente | Todas / INT |
| ANTES | IMAP e DF-e/manifestação só tinham sido testados com dublês. O simulador de DF-e podia responder em processo com NODE_ENV=production. |
| Causa | A importacao nao comparava o ambiente da nota (ide/tpAmb) com o ambiente fiscal da empresa - so a DF-e sabia de ambiente, porque o documento vinha de uma consulta com ambiente. E o cursor da Distribuicao era derivado do que foi GRAVADO, e nao do que a SEFAZ respondeu: sem documento gravado (137, ou lote so com o que nao se grava) ele nao andava, e o maxNSU nao era lido. |
| Correção | Mantido do INT/verificacao-final anterior (DFE-AMBIENTE): coluna environment e UNIQUE (company_id, environment, nsu) em core_dfe_documents, passo 85 dfe_ambiente_por_documento, lista/manifestacao/importacao por ambiente, 409 CORE_DFE_OUTRO_AMBIENTE, CORE_DFE_ESQUEMA_PENDENTE, e do INT/reauditoria a politica dos atos no DF-e. Acrescentado (R3-DFE): (1) parseNfeXml le o ambiente (ide/tpAmb; sem ele, o tpAmb do protocolo). exigirNotaComValidadeFiscal (NfeImportService), um lugar so: empresa em producao so aceita nota de producao; a de homologacao e recusada antes de gravar qualquer coisa (409 CORE_NFE_DE_HOMOLOGACAO, "nao tem validade fiscal ... Peca ao fornecedor a nota de producao") e o XML sem tpAmb legivel tambem (400 CORE_NFE_AMBIENTE_ILEGIVEL). Passam por ela importNfe (upload, e-mail e a nota completa da DF-e), a previa da rota, a confirmacao (a nota de homologacao que entrou antes da trava nao move estoque nem gera conta a pagar) e a releitura do XML guardado (fica de fora, contada em notasSemValidadeFiscal, e a frase da tela o diz). E-mail: situacao propria recusado (nao "XML invalido"), com o motivo por anexo no detalhe e a contagem de recusadas; a mensagem fica registrada por provider_uid, relida nao e reprocessada, e o cursor IMAP passa por ela - o mesmo padrao das recusas de hoje (registrar e seguir). Rotulo "Recusada" na tela do e-mail. (2) core_dfe_cursors (DDL canonica em schema.ts, PK (company_id, environment), na ordem de exclusao; tabela nova em vez de reaproveitar core_dfe_documents, porque o estado e da CONSULTA e nao de documento, e o 137 nao traz documento onde guardar): ultNSU e maxNSU da ultima resposta, last_c_stat/last_x_motivo, last_response_at, next_query_at e wait_reason (em_dia \| consumo_indevido). UPSERT com MAX(ult_nsu) - o cursor nunca recua. consultarDistribuicao: a espera e conferida antes de abrir o A1 (409 CORE_DFE_AGUARDE_A_SEFAZ com a hora da loja e o porque); parte de MAX(ultNSU guardado, MAX(nsu) gravado); laco enquanto ultNSU < maxNSU com teto LOTES_POR_CONSULTA=20 por clique (restamDocumentos; o proximo clique continua sem espera); documentos e cursor na mesma transacao por lote; em dia (137 ou ultNSU = maxNSU) proxima consulta so depois de 1 h; 656 grava o bloqueio de 1 h (409 CORE_DFE_CONSUMO_INDEVIDO) e o download da ciencia nao pede durante o bloqueio e grava o 656 se o tomar; outra recusa (ex.: 593) registra o cStat sem andar o cursor nem impor espera (409 CORE_DFE_SEFAZ_RECUSOU, antes era 200 calado). So a SEFAZ de verdade escreve o cursor (o simulador nao segura espera nem ponto de partida). SefazRealAdapter devolve maxNsu. GET /purchases/dfe devolve distribuicao (sem rota nova); a Entrada de Notas mostra "Buscar as HH:MM", desabilitado ate la, com o quadro dizendo por que (em dia ou consumo indevido) e recarregando quando a hora vence. Verificacao (e0c0357): consultarDistribuicao toma uma trava por (empresa, ambiente) em memoria (a API e instancia unica) antes do primeiro await, no mesmo tique da leitura do cursor, e a solta no finally; a segunda consulta responde 409 CORE_DFE_CONSULTA_EM_ANDAMENTO sem transmitir; o corpo dos lotes foi para consultarLotes sem mudanca. O comentario do SefazRealAdapter que prometia que o NSU de docZip corrompido 'volta na proxima consulta' foi corrigido (com o cursor pelo ultNSU ele nao volta). |
| DEPOIS | A metade IMAP se sustenta: há tela de credencial (host, usuário, senha selada no cofre), ImapFlow real e agendador ligado. A trava do simulador de DF-e se sustenta. Mas a tela de DF-e nunca manda a senha do A1 e não tem campo para ela; em produção o servidor exige a senha digitada no corpo e recusa com 400 CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED. Com o A1 já fornecido, consultar e manifestar pela tela continuam impossíveis. |
| Arquivos | server/src/routes/v1/core.ts, server/src/services/core/DfeDistribuicaoService.ts, server/src/services/core/FiscalAtosAdministrativos.ts, server/src/services/core/SefazRealAdapter.ts, server/src/services/core/SefazTestAdapter.ts, server/src/db/schema.ts, server/src/db/consolidacaoDaRemediacao.ts, server/src/db/core-migrations.ts, server/tests/dfe-pela-politica-dos-atos.test.ts, server/tests/dfe-e-manifestacao.test.ts, server/tests/atos-fiscais-pela-tela.test.ts, server/tests/sefaz-adapter-real.test.ts, server/tests/dfe-por-ambiente.test.ts, server/tests/dfe-ambiente-na-migracao.test.ts, server/tests/dfe-simulador-nao-responde-em-producao.test.ts, src/components/gs/CaminhoDoAtoFiscal.tsx, src/components/gs/SenhaDoCertificadoDialog.tsx, src/components/gs/PoliticaDosAtosFiscais.tsx, src/pages/gs/EntradaNotasPage.tsx, src/pages/gs/__tests__/entradaNotasDfePelaPolitica.test.tsx, src/pages/gs/__tests__/entradaNotasDfePorAmbiente.test.tsx, docs/audits/remediacao/migracoes/INT.md, server/src/services/core/NfeImportService.ts, server/src/services/core/MailInboxService.ts, server/src/services/core/ReleituraDasNotasRecebidas.ts, server/tests/nfe-de-homologacao-nao-entra-na-producao.test.ts, server/tests/dfe-cursor-da-sefaz.test.ts, src/pages/gs/EntradaEmailPage.tsx, src/lib/api/core.ts, src/lib/api/releituraDoXml.ts, src/pages/gs/__tests__/entradaNotasDfeProximaConsulta.test.tsx |
| COMMIT | e9daabc, 909562f, 5f06f6a, 1cd1a69, c2472d6, 7eb354f, 55d6f5d, 83a6749, 59e39fd, 681ee7f, b147aae, f239ecd, 8328b7f, 67cceb6, ee973cc, e0c0357, 43c7013 |
| TESTES | server/tests/dfe-simulador-nao-responde-em-producao.test.ts:73-120 (NODE_ENV=production e empresa em produção recusam o simulador sem gravar nada; adapter real passa; DEVORA_API_ENV também trava). Rodado: verde. Nenhum teste de tela cobre o envio da senha no DF-e; EntradaNotasFornecedor.test.tsx:86,294 só confere que o POST /dfe/consultar acontece. |
| EVIDÊNCIA | Falha: src/pages/gs/EntradaNotasPage.tsx:749-752 (POST /dfe/consultar com body {}), :775-778 (manifestar com body {tipo, justification}), sem nenhum campo de senha no arquivo; server/src/routes/v1/core.ts:8030-8036 (fiscalAdapter usa só req.body.certificatePassword); server/src/services/core/SefazRealAdapter.ts:855-878 (sem senha e com exigeAdapterReal: 400; o DF-e não usa a senha selada do cofre). Sustenta: server/src/services/core/DfeDistribuicaoService.ts:139-160, 223, 372 (exigirAdapterDeVerdade); SefazRealAdapter.ts:619 (manifest), :777 (distributionDFe); core.ts:1301 (upsertInbox); src/pages/gs/EntradaEmailPage.tsx:492-582; server/src/services/core/MailInboxService.ts:831-838; server/src/index.ts:11 |
| Veredito independente | PARCIAL (contraprova concorda) — contraprova: concorda (OPEN) |
| O que a reauditoria apontou | A ficha diz que, com o IMAP e o A1 configurados, as notas chegam sem código novo. O IMAP chega; o DF-e não chega por nenhum caminho da tela. Falta ligar o fiscalAdapter do DF-e (server/src/routes/v1/core.ts:8013-8039) ao A1 do cofre com a senha selada. Há dois jeitos de fazer isso: (a) Reusar a lógica de FiscalAtosAdministrativos.certificadoDoAto/adapterDoAtoFiscal: a senha digitada ganha; sem ela, o cofre, conforme a política do dono em core_fiscal_act_policies. Hoje adapterRealOuSimulador (SefazRealAdapter.ts:855-875) só abre o A1 quando recebe a senha no corpo. (b) Ou pelo menos pôr na EntradaNotasPage.tsx um campo de senha do A1 que envie certificatePassword em POST /core/purchases/dfe/consultar (:749-752) e em /dfe/:chave/manifestar (:775-778). Nos dois casos falta um teste de rota (supertest) em que o corpo da tela, com o A1 selado no cofre e a empresa em produção, chega ao adapter real (transporte dublado). Falta também um teste de tela de que a senha, ou o plano, viaja no corpo. |
| Correção depois da reauditoria | EXTERNAL_CONFIGURATION_REQUIRED — A reauditoria (auditor EST + contraprova) achou que, com o A1 no cofre, a consulta e a manifestação DF-e pela tela eram impossíveis: a rota só abria o A1 com certificatePassword no corpo e a tela mandava {}. 909562f: as duas passam por adapterDoAtoFiscal, a mesma política dos atos administrativos (cofre por padrão; 'cada ato pede a senha' devolve 400 com o que fazer; sem A1, 409); simulador só com developmentMode explícito e nunca em produção; tenant pelo token. 5f06f6a: a Entrada de Notas mostra o caminho do certificado e, quando a política pede, a senha num diálogo da casa. O verificador adversarial achou o ensaio antigo do simulador segurando o cursor NSU e a manifestação da chave inventada, e corrigiu em 7eb354f. Verificação final: o verificador do 7eb354f achou que o cursor NSU e o UNIQUE (company_id, nsu) não separavam homologação de produção — a empresa que homologa a Distribuição DF-e com notas reais perderia as primeiras notas de produção. 59e39fd: core_dfe_documents ganha environment e UNIQUE (company_id, environment, nsu) (DDL canônica + reconstrução idempotente no passo 85, preservando linhas, rowid, índices e imported_note_id); cursor e gravação por (empresa, ambiente); manifestar/importar documento de outro ambiente: 409 CORE_DFE_OUTRO_AMBIENTE; tabela ainda na unicidade antiga: 409 CORE_DFE_ESQUEMA_PENDENTE em vez de perder nota calada. 681ee7f: a tela diz quantos documentos do outro ambiente ficaram fora. Rodada 3: NF-e de homologação (tpAmb=2) deixou de entrar numa empresa em produção por qualquer caminho — upload, prévia, e-mail (registrada como recusada, sem reprocessar em loop), DF-e, releitura e confirmação (8328b7f); o cursor da Distribuição passa a ser o ultNSU que a SEFAZ devolve, guardado por (empresa, ambiente) em core_dfe_cursors: com ultNSU < maxNSU continua no mesmo clique (teto de 20 lotes), com 137 ou ultNSU = maxNSU espera 1 h e a tela diz a hora, 656 grava e respeita o bloqueio (67cceb6). O verificador achou dois cliques juntos repetindo o ultNSU e corrigiu com uma consulta por vez por (empresa, ambiente) (e0c0357). Prova: Verificador em int/hard-168: domínio DF-e 49/49 e 25/25; suíte do servidor 501/504 com as três falhas fora do DF-e reexecutadas isoladas (regra-rota-declara-alcance verde, a-api-tem-quem-a-levante 13/13, zip-writer: o Expand-Archive do PowerShell desta máquina leva 143 s, arquivo sem mudança desde 1078ddb); suíte de tela 255/255 (2448); tsc (3) e eslint 0. Engenheiro: dfe-por-ambiente 9/9 (8 vermelhos antes), dfe-ambiente-na-migracao 6/6 (3 vermelhos antes), entradaNotasDfePorAmbiente 2/2. Verificador adversarial: domínio 12 arquivos 142/142; suíte do servidor 507/511 com os 4 vermelhos de carga reexecutados isolados 54/54; tela 235/257 com 22 quedas de carga no carregamento reexecutadas isoladas 638/638; sondas próprias (índice único legado, resNFe+resEvento da mesma chave) sem defeito. Rodada 3: nfe-de-homologacao-nao-entra-na-producao 12 casos (9 vermelhos antes), dfe-cursor-da-sefaz 10 (9 vermelhos antes), entradaNotasDfeProximaConsulta 3 (2 vermelhos antes); verificador: domínio 24 arquivos 356/356, suíte do servidor 521/521 (7074 casos), tela 264/264 (2487). |
| STATUS FINAL | **EXTERNAL_CONFIGURATION_REQUIRED** — Configuração externa |
| Insumo externo | Credencial IMAP por empresa (Compras › NF-e por e-mail); certificado A1 com a senha em Fiscal › Certificado; homologação da Distribuição DF-e e da manifestação no ambiente real da SEFAZ. |

### GAP-PRD-169 — Homologação sandbox: dois passos sempre verdes sem executar nada e 'endpoint externo' só confere se a variável tem texto

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / FIN |
| ANTES | Os passos 'reconciliation' e 'ecommerce_bridge' ficavam verdes com frases fixas (CP59/CP61), sem executar nada. 'webhook_external' ficava verde só porque a variável tinha texto. 'ar_bridge' usava a fila legada. |
| Causa | Passos verdes por atribuicao; a corrida nova herdava verde da anterior; o servico nao devolvia o status que a tela le. |
| Correção | Cobranca do titulo manda ao sandbox o corpo do ERP (montarCobrancaAsaas, extraido de requestAsaasCharge), confere a referencia externa e cancela; Conciliacao executa GET /payments/:id e traduz pelo eventoDoStatusDoProvedor da sincronizacao; Pedido online vira not_applicable com o motivo; Webhook do ERP passa pelo handlePaymentWebhook com o token da operacao (sem token o passo cai); o aviso local tem prefixo proprio e fica fora do card do webhook; Aviso do Asaas so fica verde quando um aviso do Asaas sobre as cobrancas de teste chega (homologationProbe e POST /core/integrations/asaas/homologar/conferir-aviso); passos novos a cada corrida; status passed / failed / partial. Achado ao executar o cancelamento: AsaasHttpClient.cancelPayment chamava POST /payments/:id/cancel, endereco que a API v3 do Asaas nao tem; passa a DELETE /payments/:id. Tela: texto honesto, estados nao se aplica e aguardando, botao Conferir se o aviso do Asaas chegou, passos gravados visiveis. |
| DEPOIS | Cada passo executa o que o rótulo diz. ar_bridge: manda ao sandbox o corpo do título (montarCobrancaAsaas, o mesmo de requestAsaasCharge), confere a referência externa e cancela. reconciliation: GET /payments/:id traduzido por eventoDoStatusDoProvedor. ecommerce_bridge: not_applicable, com o motivo. webhook_local: passa pelo handlePaymentWebhook com o token da operação. webhook_external: fica awaiting_external até chegar um aviso real do Asaas sobre as cobranças de teste. Cada corrida recomeça os passos do zero, e a resposta traz status passed/failed/partial. |
| Arquivos | server/src/services/integrations/AsaasHomologationService.ts, server/src/services/core/PaymentService.ts, server/src/services/core/AsaasSincronizacao.ts, server/src/services/core/AsaasWebhookInfo.ts, server/src/services/asaas/AsaasHttpClient.ts, server/src/routes/v1/core.ts, src/lib/api/core.ts, src/pages/gs/IntegracaoAsaasPage.tsx, server/tests/homologacao-asaas-cada-verde-executou.test.ts, server/tests/helpers/asaasComEstado.ts, server/tests/cobranca-do-titulo.test.ts, server/tests/cobranca-timeout-sem-segunda.test.ts, server/tests/cancelamento-cancela-no-provedor.test.ts, server/tests/ecommerce-jornada.test.ts, src/pages/gs/__tests__/homologacaoAsaasHonesta.test.tsx |
| COMMIT | 709e0ac |
| TESTES | server/tests/homologacao-asaas-cada-verde-executou.test.ts, 12 casos. Afirma: as frases CP59/CP61 somem; o corpo do ERP vai ao provedor e é cancelado; status desconhecido reprova; sem token a homologação não passa. URL configurada sem aviso fica aguardando. Aviso de outra cobrança não prova nada; endereço local diz que o Asaas não alcança. Corrida nova não herda verde. src/pages/gs/__tests__/homologacaoAsaasHonesta.test.tsx cobre a tela. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/integrations/AsaasHomologationService.ts:309 (passos novos a cada corrida), :478-506 (ar_bridge), :508-524 (reconciliation), :526-531 (not_applicable), :533-562 (webhook_local), :123-171 (conferirAvisoExternoDaHomologacao: busca em core_payment_webhooks os ids da sonda, excluindo o prefixo local), :587-589 e :621; server/src/services/core/PaymentService.ts:498 (requestAsaasCharge usa o mesmo montarCobrancaAsaas); src/pages/gs/IntegracaoAsaasPage.tsx:550-582 e :629-639 (conferir aviso; estados não verdes). Observação sem impacto na ficha: os passos 'credential' e 'environment' (:82-87) seguem verdes pela presença da credencial. Isso é estado de configuração, não frase decorativa. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Rodar a homologação com a chave sandbox real de cada operação e cadastrar a URL pública do webhook, com o token, no painel do Asaas (DEVORA_PUBLIC_BASE_URL ou ASAAS_WEBHOOK_PUBLIC_URL). Não verifiquei contra o sandbox real que DELETE /payments/:id cancela. |

### GAP-PRD-170 — Ordem das travas de produção: salvar chave zera selos, homologar derruba o pedido de produção, e a chave de produção nunca é testada antes de valer

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / FIN |
| ANTES | Salvar qualquer chave zerava a conexão e a homologação. A homologação regravava environment='sandbox' e desfazia o pedido de produção. O selo de conexão era satisfeito pela chave sandbox, então a chave de produção nunca era testada antes de valer. |
| Causa | Um selo de conexao so para dois ambientes, reset sem ambiente e a homologacao sobrescrevendo o ambiente pedido. |
| Correção | Selos por ambiente (connectionVerified para o sandbox; productionConnectionVerified, productionConnectionTestedAt e productionConnectionError para a producao); a tranca CREDENCIAL_DE_PRODUCAO_NAO_TESTADA le o selo da producao; resetAsaasConnectionState(scope, environment) derruba so os selos da chave que mudou (rotas do nucleo e Central de Integracoes); testAsaasSandboxConnection nao grava environment; POST /core/integrations/asaas/test testa cada chave no proprio ambiente via testAsaasCredential (producao em ASAAS_PRODUCTION_BASE_URL e so com ASAAS_PRODUCTION_ENABLED; sem chamada, e dito) e devolve results por ambiente; secretsReadiness.goLiveDoAsaas le o selo da producao. Tela: selo por chave, tranca em portugues, erro da chave de producao; GO_LIVE_CHECKLIST atualizado. |
| DEPOIS | Cada ambiente tem seu selo: connectionVerified para o sandbox e productionConnectionVerified para a produção. A trava CREDENCIAL_DE_PRODUCAO_NAO_TESTADA lê o selo da produção. Guardar ou remover uma chave derruba só os selos daquele ambiente. O teste do sandbox não grava environment. POST /test testa cada chave no próprio ambiente: a de produção vai a ASAAS_PRODUCTION_BASE_URL/myAccount, e só com ASAAS_PRODUCTION_ENABLED. |
| Arquivos | server/src/services/integrations/AsaasIntegrationStateService.ts, server/src/services/core/PaymentService.ts, server/src/routes/v1/core.ts, server/src/services/integrations/AsaasHomologationService.ts, server/src/services/integrations/IntegrationsService.ts, server/src/db/secretsReadiness.ts, src/lib/api/core.ts, src/pages/gs/IntegracaoAsaasPage.tsx, docs/GO_LIVE_CHECKLIST.md, server/tests/asaas-trancas-independentes-da-ordem.test.ts, server/tests/asaas-por-operacao.test.ts, server/tests/o-que-ainda-bloqueia-a-publicacao.test.ts, src/pages/gs/__tests__/asaasTrancasPorChave.test.tsx, docs/audits/remediacao/migracoes/FIN.md |
| COMMIT | 097969b |
| TESTES | server/tests/asaas-trancas-independentes-da-ordem.test.ts, 8 casos. Afirma: depois de testar, homologar, pedir produção e guardar a chave de produção, só falta testar a produção. Trocar a chave sandbox derruba só os selos do sandbox; remover a de produção derruba só o selo dela. O teste do sandbox não grava environment. O teste vai às duas contas, cada uma com a própria chave, e a porta abre. Chave recusada deixa o selo fechado. Com produção desligada não há chamada. src/pages/gs/__tests__/asaasTrancasPorChave.test.tsx cobre a tela. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/integrations/AsaasIntegrationStateService.ts:108-125 (trava lê productionConnectionVerified) e :136-161 (reset por ambiente); server/src/routes/v1/core.ts:13812-13819 e :13954-13957 (PUT e DELETE passam o ambiente; são os únicos chamadores), :14017-14069 (teste por ambiente, selo como consequência, auditoria); server/src/services/integrations/AsaasHomologationService.ts:219-223 (sem environment); server/src/services/core/PaymentService.ts:208-236 (testAsaasCredential); src/pages/gs/IntegracaoAsaasPage.tsx:34 e :234-256. Não verifiquei: o padrão de ASAAS_PRODUCTION_BASE_URL é 'https://api.asaas.com/api/v3' (server/src/config/env.ts:294, .env.example:96). A URL é configurável por variável; um caminho errado apareceria no teste como 'Endereço da API não encontrado', sem precisar de código. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Chave de produção de cada operação, ASAAS_PRODUCTION_ENABLED=true no servidor e um clique em 'Testar conexão'. Confirmar que ASAAS_PRODUCTION_BASE_URL aponta para a base de produção atual do Asaas. |

### GAP-PRD-171 — Sete lançamentos quitados sem linha de baixa no banco real (anteriores ao V29): invisíveis à conciliação bancária

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DATA_INTEGRITY_RISK |
| Empresa / frente | Preço Justo, Gringa, Oficina / FIN |
| ANTES | Sete lançamentos quitados antes do V29 (R$ 6.223,45) não tinham linha em core_finance_settlements. Ficavam fora da conciliação bancária, e o código decidiu não retroagir. |
| Causa | Fatia a vista pre-V29 sem baixa-espelho; criar baixa retroativa muda a conciliacao de meses ja vividos, o que e decisao de quem responde pelo caixa. |
| Correção | Mecanismo completo, sem rodar sozinho: BaixasLegadas.listarQuitacoesSemBaixa (vivos com settled_cents maior que a soma das baixas, com o que falta e a data da quitacao original) e criarBaixasEspelhoLegadas (so com confirm: true; baixa com settled_at da quitacao original, forma do lancamento, quem decidiu e nota de migracao; idempotente; filtro por lancamento; nao mexe em settled_cents, saldo, resumo nem DRE). Rotas GET /core/finance/legacy-settlements e POST /core/finance/legacy-settlements/mirror (gerencia, auditoria finance.legacy_settlements_mirrored). Cartao Quitacoes antigas sem baixa na conciliacao bancaria, com confirmacao. |
| DEPOIS | O mecanismo está completo e não roda sozinho. O cartão 'Quitações antigas sem baixa' na Conciliação bancária lista os lançamentos com o valor que falta e a data. Com confirmação explícita, cria a baixa-espelho com a data da quitação original, a forma do lançamento, quem decidiu e a nota de migração. A operação é idempotente e cercada pela empresa, e não mexe em settled_cents, saldo nem DRE. As duas opções existem: não fazer nada (o estado atual) ou clicar. Escolher é só operar a tela. |
| Arquivos | server/src/services/core/BaixasLegadas.ts, server/src/routes/v1/core.ts, src/components/gs/QuitacoesSemBaixaCard.tsx, src/lib/api/baixasLegadas.ts, src/pages/gs/ConciliacaoBancariaPage.tsx, server/tests/quitacoes-antigas-sem-baixa.test.ts, src/pages/gs/__tests__/quitacoesSemBaixa.test.tsx, docs/audits/remediacao/migracoes/FIN.md |
| COMMIT | 4970d52 |
| TESTES | server/tests/quitacoes-antigas-sem-baixa.test.ts, 9 casos. Afirma: lista só quitadas sem baixa, vivas e desta operação; parcial conta só o que falta. Sem confirmação nada é gravado. Confirmada, a baixa leva a data original, a forma, o usuário e a nota. O segundo clique não duplica. Saldo, resumo e DRE não mudam, e a conciliação passa a sugerir. Filtro por lançamento funciona; outra operação não vê nem cria; o caixa recebe 403. src/pages/gs/__tests__/quitacoesSemBaixa.test.tsx cobre a tela. Rodei os dois: verdes. Não abri o banco real, então não reconferi os 7 lançamentos. |
| EVIDÊNCIA | server/src/services/core/BaixasLegadas.ts:71-102 (o que falta = settled_cents - soma das baixas, por empresa), :120-166 (sem confirm dá 400; recalcula dentro da transação); server/src/routes/v1/core.ts:6458-6491 (GET e POST só para gerência; auditoria finance.legacy_settlements_mirrored); src/components/gs/QuitacoesSemBaixaCard.tsx:23 e :108 (confirmação); src/lib/api/baixasLegadas.ts:43-44; src/pages/gs/ConciliacaoBancariaPage.tsx:329. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel decide se cria as baixas-espelho dos lançamentos antigos. Se sim, é um clique com confirmação em Financeiro > Conciliação bancária. Se não, nada a fazer. |

### GAP-PRD-172 — 'Cancelada' tem um critério em sete leitores e outro no saldo da conta bancária

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / FIN |
| ANTES | accountBalanceCents usava status <> 'cancelled', enquanto os outros sete leitores usavam cancelled_at IS NULL. O critério de cancelado era outro no saldo da conta. |
| Causa | Oitavo leitor com criterio proprio de cancelado (status derivado em vez do carimbo). |
| Correção | accountBalanceCents usa cancelled_at IS NULL como os outros sete leitores; settled_cents ja e o liquido das baixas nao estornadas (reverseSettlement subtrai). A migracao 56 ja carimbou os antigos: nenhum saldo existente muda. |
| DEPOIS | O saldo da conta usa cancelled_at IS NULL, como os outros leitores. settled_cents já é o líquido das baixas não estornadas, porque reverseSettlement subtrai. |
| Arquivos | server/src/services/core/FinanceSetupService.ts, server/tests/saldo-da-conta-segue-o-carimbo.test.ts, server/tests/financeiro-fundacao.test.ts |
| COMMIT | 17f6525 |
| TESTES | server/tests/saldo-da-conta-segue-o-carimbo.test.ts, bloco GAP-PRD-172 com 3 casos. Afirma: lançamento carimbado sem status cancelled não entra no saldo; saldo e resumo concordam sobre o mesmo conjunto; a tela de cadastros recebe o saldo pelo mesmo critério. Rodei: verde. |
| EVIDÊNCIA | server/src/services/core/FinanceSetupService.ts:483-491 (WHERE ... AND cancelled_at IS NULL); server/src/services/core/FinanceService.ts:785 (reverseSettlement faz settled_cents = settled_cents - ?). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-173 — POST /finance/entries/:id/settle sem Idempotency-Key: dois cliques paralelos viram duas baixas

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / FIN |
| ANTES | POST /finance/entries/:id/settle não lia Idempotency-Key. Dois POST parciais iguais em paralelo viravam duas baixas. |
| Causa | A rota de baixa nao tinha memoria do pedido; o teto do devido segura o total, nao a repeticao de uma parcial. |
| Correção | Tabela nova core_finance_settle_requests (DDL canonica, PK empresa + chave); settleEntry aceita idempotencyKey e grava o pedido na mesma transacao da baixa; o reenvio devolve a baixa ja feita (replayed: true, sem segunda linha nem segunda auditoria); a mesma chave para outro titulo ou valor e 409 CORE_IDEMPOTENCY_CONFLICT; a rota le header ou corpo. ContasPage gera a chave no primeiro clique, reusa no reenvio do mesmo pedido, troca depois do sucesso e fecha a janela do clique duplo. |
| DEPOIS | A rota lê a chave do cabeçalho ou do corpo. settleEntry grava o pedido em core_finance_settle_requests (PK empresa+chave) na mesma transação da baixa. O reenvio devolve replayed:true, sem segunda linha nem segunda auditoria. Mesma chave com outro título ou outro valor dá 409. A ContasPage gera a chave no primeiro clique, reusa no reenvio, troca depois do sucesso e trava o clique duplo (emVoo). |
| Arquivos | server/src/db/schema.ts, server/src/services/core/FinanceService.ts, server/src/routes/v1/core.ts, src/lib/api/core.ts, src/pages/gs/ContasPage.tsx, server/tests/baixa-com-idempotency-key.test.ts, src/pages/gs/__tests__/baixaComChave.test.tsx, docs/audits/remediacao/migracoes/FIN.md |
| COMMIT | 17f6525, 8496283 |
| TESTES | server/tests/baixa-com-idempotency-key.test.ts, 6 casos. Afirma: dois POST iguais em paralelo com a mesma chave dão uma baixa só. Reenvio depois de quitar devolve a baixa. Mesma chave com outro valor ou outro título dá 409 e nada é gravado. A chave é por empresa; sem chave, o comportamento antigo segue. src/pages/gs/__tests__/baixaComChave.test.tsx afirma: a chave começa com 'baixa-'; é reusada quando a resposta se perde (o saldo fica em 7000, não 4000); é trocada depois do sucesso. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/core/FinanceService.ts:571-610 (confere a chave antes de tudo; 409 CORE_IDEMPOTENCY_CONFLICT) e :679-693 (INSERT na mesma transação); server/src/db/schema.ts:2176-2185 e :5458 (na ordem de exclusão); server/src/routes/v1/core.ts:6364-6399 (header ou body; auditoria só quando não é replay); src/lib/api/client.ts:589 (cabeçalho Idempotency-Key); src/lib/api/core.ts:4748-4758; src/pages/gs/ContasPage.tsx:1220-1261. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-174 — Título do fechamento de comissão não navega de volta ao fechamento por id

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas / FIN |
| ANTES | O título da comissão nascia com origin_type 'manual' e apontava para si mesmo. Do contas a pagar não se chegava ao fechamento, e nenhuma tela lia o histórico de fechamentos. |
| Causa | createEntry so escrevia manual; o vinculo morava so em core_commission_closings.finance_entry_id. |
| Correção | createEntry aceita origin { type: commission_closing, id }; fecharPeriodo aponta o titulo para o fechamento; ORIGEM_LEGIVEL_SQL ganha o setimo ramo (vendedor e periodo) com JOIN cercado pela empresa; o DRE nomeia a origem. Leitor do historico GET /core/commissions/closings e /closings/:id (gerencia, 404 entre empresas) com as linhas e a situacao do titulo. Tela: aba Comissoes > Fechamentos com ?fechamento=<id>; destinoDaOrigem leva do contas a pagar ao fechamento. |
| DEPOIS | fecharPeriodo cria o título com origin commission_closing e origin_id igual ao id do fechamento. ORIGEM_LEGIVEL_SQL rotula com vendedor e período, num JOIN cercado pela empresa. O contas a pagar leva a /sistema/financeiro/comissoes?fechamento=<id>. A aba Fechamentos lista o histórico. GET /commissions/closings/:id devolve 404 entre empresas e é só para gerência. |
| Arquivos | server/src/services/core/FinanceService.ts, server/src/services/core/CommissionService.ts, server/src/services/core/IncomeStatementService.ts, server/src/routes/v1/core.ts, src/components/gs/FechamentosDeComissao.tsx, src/lib/api/fechamentosDeComissao.ts, src/lib/rotasDeOrigem.ts, src/pages/gs/ComissoesPage.tsx, server/tests/comissao-titulo-leva-ao-fechamento.test.ts, server/tests/titulo-e-origem-sao-navegaveis.test.ts, src/pages/gs/__tests__/comissaoFechamentoNavegavel.test.tsx, docs/audits/remediacao/migracoes/FIN.md |
| COMMIT | 6ac38e2 |
| TESTES | server/tests/comissao-titulo-leva-ao-fechamento.test.ts, 6 casos. Afirma: o título nasce com a origem e o rótulo; a volta pelo filtro de origem; o histórico traz título e situação; o fechamento por id traz as vendas; outra operação dá 404; o caixa dá 403. server/tests/titulo-e-origem-sao-navegaveis.test.ts varre as origens. src/pages/gs/__tests__/comissaoFechamentoNavegavel.test.tsx cobre a tela. Rodei os três: verdes. |
| EVIDÊNCIA | server/src/services/core/CommissionService.ts:637 (origin), :761-772 (getClosing cercado pela empresa, 404); server/src/services/core/FinanceService.ts:962-970, :1012 e :1052-1053 (grava origin_type e origin_id), :224-229 e :245-248 (rótulo e JOIN com company_id); server/src/routes/v1/core.ts:11208-11230; src/lib/rotasDeOrigem.ts:103-107 e :134-135; src/pages/gs/ComissoesPage.tsx:49, :71 e :553. Títulos antigos: há passo de correção em server/src/db/consolidacaoDaRemediacao.ts:235-247. Não verifiquei se ele já rodou no banco da loja. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-175 — Suíte não é determinística à noite nem no calendário: 3 falhas de teste (produto certo) na rodada das 22:58 de Pelotas

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | n/a / DEP |
| ANTES | audit-finance calculava o D+30 pelo dia UTC e falhava às 22:58 de Pelotas. conciliacao-bancaria-fecha tinha PERIODO fixo em agosto com baixa no 'agora' e falhava desde 01/09. |
| Causa | Os testes datavam pelo dia UTC e por período fixo; o produto data pelo dia da loja e carimba com o agora. |
| Correção | audit-finance vive às 22:58 de Pelotas (vi.useFakeTimers só de Date, com shouldAdvanceTime) e confere o D+30 por diaDaLoja(created_at); os dois 'any' do DRE viraram tipo. conciliacao-bancaria-fecha começa o relógio em 20/08/2026, dentro do PERIODO. |
| DEPOIS | audit-finance vive às 22:58 de Pelotas (relógio falso só de Date) e confere o D+30 por diaDaLoja(created_at). conciliacao-bancaria-fecha fixa o relógio em 15/08/2026, dentro do PERIODO; o journal dizia 20/08, mas o código diz 15/08, o que dá no mesmo. |
| Arquivos | server/tests/audit-finance.test.ts, server/tests/conciliacao-bancaria-fecha.test.ts |
| COMMIT | 38807c1 |
| TESTES | Os dois arquivos rodados em 12/09/2026 às 21:21 da máquina (fora de agosto e à noite): verdes. |
| EVIDÊNCIA | server/tests/audit-finance.test.ts:50-52 (2026-09-11T01:58Z), :247-248, :267; server/tests/conciliacao-bancaria-fecha.test.ts:67-71 (AGORA_NO_PERIODO), :123 (PERIODO). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-176 — Pacote do contador sem hash/checksum de integridade

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas / FIS |
| ANTES | O pacote do contador não tinha hash de integridade. A prova era só descrição textual. |
| Causa | O pacote nunca calculou nem registrou hash; a integridade era so descricao textual. |
| Correção | Servidor: coluna sha256 no MANIFESTO (SHA-256 dos bytes UTF-8 que o zip grava; vazia em linha sem arquivo); secao INTEGRIDADE no LEIA-ME com o SHA-256 do MANIFESTO e como conferir (certutil/sha256sum) - o do zip nao cabe dentro dele; montarPacote devolve sha256 e manifestoSha256; o download manda X-Pacote-Sha256 (exposto no CORS) e grava os dois na trilha; o e-mail escreve o hash do anexo (quando anexa) e o do MANIFESTO, e a trilha e o payload os levam; GET /core/fiscal/closings/conferir?sha256= (gerentes e contador, so a empresa do token, 400 CORE_FISCAL_SHA256_INVALIDO fora do formato) reconhece o hash do zip ou do MANIFESTO contra as entregas registradas. Tela: o fechamento mostra o SHA-256 do cabecalho depois do download (nenhum sem cabecalho) e o quadro 'Conferir um pacote recebido' aceita o hash colado ou calcula o do arquivo no navegador (so o numero sobe); apiBinary devolve os cabecalhos (campo opcional). |
| DEPOIS | O MANIFESTO tem uma coluna sha256 por arquivo, e o LEIA-ME traz o SHA-256 do MANIFESTO com instrução de conferência. O download manda X-Pacote-Sha256 (exposto no CORS) e grava sha256 e manifestoSha256 na trilha; o e-mail escreve os dois hashes. GET /core/fiscal/closings/conferir reconhece o hash só na empresa do token, para gerentes e contador. A tela mostra o hash e confere arquivo ou hash colado. |
| Arquivos | server/src/services/core/FiscalClosingService.ts, server/src/services/core/ConferenciaDoPacote.ts, server/src/services/core/ContadorEnvioService.ts, server/src/routes/v1/core.ts, server/src/app.ts, server/tests/pacote-do-contador-dia-da-loja-e-integridade.test.ts, server/tests/fechamento-contador.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/client.ts, src/lib/api/pacoteDoContador.ts, src/components/gs/ConferirPacoteCard.tsx, src/pages/gs/FechamentoContadorPage.tsx, src/pages/gs/__tests__/pacoteDoContadorIntegridade.test.tsx |
| COMMIT | 1ef9f6f, 9eb4e80 |
| TESTES | server/tests/pacote-do-contador-dia-da-loja-e-integridade.test.ts:263-466: o hash no MANIFESTO bate com os bytes; linha sem arquivo não tem hash; LEIA-ME com certutil e sha256sum; cabeçalho e trilha; e-mail; conferir reconhece zip e MANIFESTO; zip alterado não é reconhecido; a vizinha não enxerga; 400 CORE_FISCAL_SHA256_INVALIDO; o caixa leva 403. Rodei: verde. Tela: pacoteDoContadorIntegridade.test.tsx, verde. |
| EVIDÊNCIA | server/src/services/core/FiscalClosingService.ts:1335-1351, :1381, :1715-1735; core.ts:8453-8505 (download com trilha e cabeçalho; conferir com requireProfile e companyId do token); ConferenciaDoPacote.ts:62-119; ContadorEnvioService.ts:434-441, :549, :604; app.ts:118; src/components/gs/ConferirPacoteCard.tsx:61; FechamentoContadorPage.tsx:941. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-177 — Conciliação bancária lista no máximo 500 linhas e 50 extratos sem sinal de truncagem

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / FIN |
| ANTES | listLines tinha LIMIT 500 e listStatements LIMIT 50, sem sinal de corte. Extratos com mais de 500 linhas perdiam o fim na tela, em silêncio. |
| Causa | Lista de trabalho com teto fixo e sem total na resposta. |
| Correção | listLinesPage / listStatementsPage devolvem items, total, limit, offset e truncated (padrao 500 / 50, teto 2000), aceitam offset e o filtro onlyMatched; ordem com id como desempate. A tela pede pendentes e casadas em paginas separadas, diz Mostrando X de Y e busca a proxima pagina. |
| DEPOIS | listLinesPage e listStatementsPage devolvem items, total, limit, offset e truncated. O padrão continua 500 e 50, com teto de 2000, e a ordem desempata pelo id. As rotas aceitam limit, offset e onlyMatched. A tela pede pendentes e casadas separadas, diz 'Mostrando X de Y' e busca a próxima página. |
| Arquivos | server/src/services/core/BankReconciliation.ts, server/src/routes/v1/core.ts, src/lib/api/core.ts, src/pages/gs/ConciliacaoBancariaPage.tsx, server/tests/conciliacao-bancaria-declara-o-corte.test.ts, src/pages/gs/__tests__/conciliacaoBancariaDeclaraOCorte.test.tsx, src/pages/gs/__tests__/conciliacaoDesfazEArquivo.test.tsx |
| COMMIT | 75eb8d8 |
| TESTES | server/tests/conciliacao-bancaria-declara-o-corte.test.ts, 6 casos. Afirma: com 530 linhas a primeira página traz 500 e truncated; a segunda traz o fim sem repetir nem pular; as casadas vêm à parte, com o próprio total; o limite respeita o teto; a lista de extratos declara o corte; linhas de outra operação ficam fora. src/pages/gs/__tests__/conciliacaoBancariaDeclaraOCorte.test.tsx cobre a tela. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/core/BankReconciliation.ts:488-507 (Pagina e paginacao), :509-535 (extratos com total e truncated), :550-585 (linhas com total, truncated e ORDER BY occurred_at, id); server/src/routes/v1/core.ts:15729-15762 (só gerência; companyId do token); src/pages/gs/ConciliacaoBancariaPage.tsx:129-160 e :642-660. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-178 — Questionário do contador está coerente com o código, mas não diz que NCM/CEST/origem já vêm sugeridos do XML do fornecedor

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / FIS |
| ANTES | O questionário pedia ao contador para classificar NCM, CEST e origem por planilha. Não dizia que o XML do fornecedor já os sugere. |
| Causa | O roteiro da reuniao com o contador nao acompanhou o FiscalSuggestionService (nem, depois, o GAP-PRD-021). |
| Correção | Secao 4 reescrita: NCM, CEST e origem vem sugeridos do XML de entrada; o contador confirma em lote e classifica so o PENDENTE/DIVERGENTE, na tela "Sugestoes do XML do fornecedor" (Fiscal > Configuracao) ou na alteracao rapida; o CFOP nunca e sugerido. "O que NAO precisamos perguntar" passa a dizer isso (e o que o A1 e o checklist de tributacao ja respondem). Secoes 2 e 3 acompanham o GAP-PRD-021 (CRT 1-4, CSOSN 500/CST 60 emitidos, ST por fora recusada, aliquota de ICMS, FCP e cBenef; CFOP do grupo vale para todo produto sem o seu). Teste de coerencia le o roteiro e o codigo: CAMPOS_SUGERIVEIS, TabelasDoIcms e o titulo do cartao em FiscalPage.tsx. |
| DEPOIS | A seção 4 do questionário manda confirmar em lote as sugestões do XML e classificar só o PENDENTE/DIVERGENTE, e diz que o CFOP nunca é sugerido. 'O que NÃO precisamos perguntar' cita as sugestões do XML e o checklist por grupo tributário. Um teste confronta o texto com o código. |
| Arquivos | docs/QUESTIONARIO-CONTADOR.md, server/tests/questionario-do-contador-bate-com-o-codigo.test.ts |
| COMMIT | 70bd11d |
| TESTES | server/tests/questionario-do-contador-bate-com-o-codigo.test.ts (10): cada campo de CAMPOS_SUGERIVEIS aparece como sugerido; a planilha fica só para PENDENTE/DIVERGENTE; o CFOP nunca é sugerido; a tela citada existe com esse nome; os CST batem com a emissão. Rodei: verde. |
| EVIDÊNCIA | docs/QUESTIONARIO-CONTADOR.md:45-59 (seção 4, itens 4.1-4.3) e :113-120 (O que NÃO precisamos perguntar). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Levar o roteiro atualizado à reunião com o contador. Não é código. |

### GAP-PRD-179 — Revogação lógica não apaga a senha selada e reenvio mantém revokedAt/revokeReason no registro válido

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 — ajuste P2→P3 (fase 2) / SECURITY_RISK (após refutação: P3 / SECURITY_RISK) |
| Empresa / frente | Todas as seis / FIS |
| ANTES | Revogar apagava o .pfx cifrado e deixava a senha selada. O reenvio voltava a 'valid' com o revokedAt e o revokeReason antigos. |
| Causa | Revogacao apagava metade do segredo; o reenvio mesclava a linha nova sobre a revogada. |
| Correção | revokeCertificate remove encryptedPfx E encryptedPassword (fica so o que o certificado publica: titular, serie, validade, impressao digital). upsertCertificateA1 remove revokedAt/revokeReason do topo e guarda o certificado que sai de cena em historico (lista FECHADA de campos, sem segredo, ate 20 trocas; o resto na auditoria). Tela: a confirmacao de desativar diz que o arquivo e a senha selada saem do cofre. |
| DEPOIS | revokeCertificate zera encryptedPfx e encryptedPassword. O upsert tira revokedAt e revokeReason do topo e guarda o certificado anterior em historico, sem segredo e com limite de trocas. A tela de desativar avisa que o arquivo e a senha saem do cofre. |
| Arquivos | server/src/services/core/CertificateStatusService.ts, server/src/services/fiscal/FiscalCertificateService.ts, server/tests/revogar-o-a1-apaga-a-senha.test.ts, src/pages/gs/CertificadoPage.tsx, src/pages/gs/__tests__/certificadoSemSenhaSelada.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | 2a2fa8d, 8454c0d |
| TESTES | server/tests/revogar-o-a1-apaga-a-senha.test.ts (8): pelo serviço e pela rota, sem .pfx nem senha; nada abre o certificado revogado; o reenvio volta a valid sem carimbo; o histórico guarda impressão digital, série, validade e motivo, sem segredo. Rodei: verde. Tela: certificadoSemSenhaSelada.test.tsx, verde. |
| EVIDÊNCIA | server/src/services/core/CertificateStatusService.ts:284-304 (encryptedPfx e encryptedPassword undefined); server/src/services/fiscal/FiscalCertificateService.ts:461-483 (revokedAt e revokeReason undefined, historico). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-180 — Unidade operacional: upload/GET/teste SEFAZ aceitam operationalUnitId, mas readiness, lista do grupo, pipeline e CSC cravam 'unit-default' — certificado sob outra unidade fica invisível

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas as seis (sem efeito hoje: nenhuma tela envia unidade; não existe tabela de unidades) / FIS |
| ANTES | Upload, GET e teste da SEFAZ aceitavam operationalUnitId. Readiness, lista do grupo, pipeline e CSC cravavam 'unit-default', e o certificado guardado sob outra unidade ficava invisível. |
| Causa | Contrato parcial: as rotas que gravam aceitavam qualquer unidade, as que emitem so leem unit-default, e nao existe cadastro de unidades operacionais. |
| Correção | Correcao recomendada pela ficha (remover a unidade do contrato publico): server/src/services/core/UnidadeFiscal.ts com UNIDADE_FISCAL e unidadeFiscalDoPedido - ausente/vazio/unit-default => a da operacao; qualquer outra => 400 CORE_FISCAL_UNIT_NOT_SUPPORTED com o motivo, antes de gravar ou abrir cofre. Aplicado em GET/POST /core/fiscal/certificate, /core/fiscal/certificate/revoke, /core/fiscal/sefaz/status (conferido no topo, antes da UF), /fiscal/nfce/csc, /fiscal/nfce/qrcode/build, /fiscal/nfce/service-status, /fiscal/nfe/service-status, /fiscal/certificates, /fiscal/certificates/test-signature e /integrations/{nfe,nfce}/secrets (que deixam de usar o storeId). O cliente da tela deixa de mandar operationalUnitId no CSC. Achado no mesmo trecho: /integrations/{nfe,nfce}/secrets devolviam a linha crua (o .pfx, a senha e o token cifrados no corpo) - passam a responder sanitizado. |
| DEPOIS | Aplicada a correção recomendada: a unidade saiu do contrato público. unidadeFiscalDoPedido aceita ausente, vazio ou unit-default e recusa qualquer outra com 400 CORE_FISCAL_UNIT_NOT_SUPPORTED antes de gravar. Vale para GET e POST do certificado, revoke, CSC e sefaz/status. As rotas legadas /fiscal/* e /integrations saíram, e o cliente da tela não manda unidade no CSC. Os leitores seguem em unit-default, coerentes com a única unidade aceita. |
| Arquivos | server/src/services/core/UnidadeFiscal.ts, server/src/routes/v1/core.ts, server/src/routes/v1/nfce.ts, server/src/routes/v1/nfe.ts, server/src/routes/v1/fiscal.ts, server/src/routes/v1/integrations.ts, server/tests/a-unidade-fiscal-e-uma-so.test.ts, server/tests/sefaz-teste-de-comunicacao.test.ts, src/lib/api/core.ts, src/pages/gs/__tests__/fiscalCscPorAmbiente.test.tsx, docs/audits/remediacao/migracoes/FIS.md |
| COMMIT | ae29403, 65eefe4 |
| TESTES | server/tests/a-unidade-fiscal-e-uma-so.test.ts (12): outra unidade leva 400 e nada é gravado, no POST, GET ?unit, revoke, teste da SEFAZ e CSC; unit-default explícito é enxergado pela prontidão e pelo grupo; /fiscal/certificates e /integrations dão 404. Rodei: verde. Tela: fiscalCscPorAmbiente.test.tsx, verde. |
| EVIDÊNCIA | server/src/services/core/UnidadeFiscal.ts:26-49; core.ts:4336, :4357, :4433, :4493, :7431; src/lib/api/core.ts:4553-4559 (corpo do CSC sem unidade). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-181 — XML de entrada: parser não extrai IE/endereço/IBGE do emitente, modelo, destinatário nem CST/CSOSN/PIS/COFINS/IPI/ICMS por item; produtos do banco real receberam NCM da nota sem procedência

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | Todas as seis / FIS |
| ANTES | O parser do XML de entrada não extraía IE, endereço e IBGE do emitente, modelo, destinatário nem a tributação por item. O fornecedor entrava só com nome e documento, e o produto recebia o NCM da nota sem procedência. |
| Causa | Parser que so lia o necessario para a entrada de estoque; cadastro do fornecedor sem autopreenchimento; procedencia nao gravada na criacao do produto; sugestoes so para notas novas. |
| Correção | Parser: model, supplier (tradeName, stateRegistration, crt, street, number, complement, district, cityIbge, city, state, zip, phone), recipient e taxes por item (campo procurado pelo nome dentro de qualquer filho do grupo, como a origem; nulo quando nao declarado). Importacao: completarFornecedorPeloXml preenche SO campo em branco (o digitado fica; o IBGE so entra quando a cidade do cadastro e a do XML), com trilha supplier.autofill_xml; a nota grava modelo e destinatario, o item grava a tributacao declarada; o produto criado pela confirmacao grava fiscal_classification_source='xml_fornecedor' (sem confirmar); updateSupplier apaga o IBGE quando a cidade ou a UF mudam. Retroacao: POST /core/fiscal/classification/reler-notas (gerencia) rele o xml_original de cada nota da empresa, completa so o que e nulo (nota, fornecedor, CEST/origem/tributos do item pela posicao quando a contagem bate), cria as sugestoes (recordSuggestionsFromNote) e da a procedencia so ao produto que se prova nascido da nota (criado entre a importacao e a confirmacao, com o nome da linha e o NCM do arquivo); idempotente, com trilha fiscal.inbound_notes_reread; conta notas sem arquivo e ilegiveis. Tela: botao 'Reler as notas ja recebidas' nos dois estados do cartao das sugestoes do XML, com a frase do que achou. A tributacao de compra continua sem tocar o produto. |
| DEPOIS | O parser lê o emit completo (xFant, IE, CRT, enderEmit, cMun, CEP, fone), o modelo, o dest e os tributos por item. completarFornecedorPeloXml preenche só campo vazio, põe o IBGE só se a cidade bate, e grava trilha supplier.autofill_xml. O produto criado grava fiscal_classification_source='xml_fornecedor'. A rota reler-notas, da gerência e na empresa do token, faz a retroação, e há botão na tela. |
| Arquivos | server/src/services/core/NfeImportService.ts, server/src/services/core/SupplierService.ts, server/src/services/core/ReleituraDasNotasRecebidas.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/o-xml-do-fornecedor-completa-o-cadastro.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/lib/api/releituraDoXml.ts, src/pages/gs/FiscalPage.tsx, src/pages/gs/__tests__/releituraDasNotasNaTela.test.tsx |
| COMMIT | 14f87f2 |
| TESTES | server/tests/o-xml-do-fornecedor-completa-o-cadastro.test.ts (16): parser de modelo, emitente, destinatário e tributos; só o campo vazio é preenchido; mudar a cidade apaga o IBGE; procedência xml_fornecedor; a releitura é idempotente, fica na empresa do token e dá 403 ao caixa e ao estoquista. Rodei: verde. Tela: releituraDasNotasNaTela.test.tsx, verde. |
| EVIDÊNCIA | server/src/services/core/NfeImportService.ts:312-338 (emitente e destinatário), :476, :492-493, :832-884 (completarFornecedorPeloXml), :1075-1084 (tributos do item), :2002 (xml_fornecedor); ReleituraDasNotasRecebidas.ts; core.ts:7762-7766; src/pages/gs/FiscalPage.tsx:1163-1179. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-182 — Portal decide orçamento de OS que já saiu da bancada (aguardando pagamento) e apaga o pedido de aprovação

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | O portal aceitava recusar o orçamento de OS já em aguardando_pagamento e apagava approval_requested_at. A conclusão técnica deixava o pedido de aprovação pendurado. |
| Causa | a decisao do cliente nao conhecia a regua ORDER_STATUSES_ON_BENCH que o pedido ja usava, e a conclusao deixava o pedido pendurado |
| Correção | decidirOrcamento (usado pelo portal e pelo aceite do balcao) recusa OS fora da bancada com PORTAL_ORDER_NOT_ON_BENCH 409 antes de apagar qualquer coisa (clique repetido de aprovar continua idempotente); completeTechnical encerra o pedido pendente (approval_requested_at = NULL, aprovacao ja dada fica) com comentario na linha do tempo; portal ganha aguardandoDecisao calculado no servidor e a pagina so mostra os botoes com ele; a ficha nao anuncia pedido pendurado fora da bancada |
| DEPOIS | decidirOrcamento recusa OS fora da bancada com 409 PORTAL_ORDER_NOT_ON_BENCH antes de gravar qualquer coisa; o aprovar repetido segue idempotente. completeTechnical encerra o pedido pendente e deixa comentário. O portal só mostra os botões com aguardandoDecisao, calculado no servidor. |
| Arquivos | server/src/services/core/EquipmentPortalService.ts, server/src/services/core/WorkshopCoreService.ts, src/pages/gs/MeusEquipamentosPage.tsx, src/pages/gs/OrdemServicoPage.tsx, server/tests/quem-mexe-na-os.test.ts, src/pages/gs/__tests__/MeusEquipamentosAprovacao.test.tsx, src/pages/gs/__tests__/quemMexeNaOs.test.tsx, docs/audits/remediacao/migracoes/OFI.md |
| COMMIT | c699bcf |
| TESTES | server/tests/quem-mexe-na-os.test.ts:543-628: portal e balcão fora da bancada levam 409 PORTAL_ORDER_NOT_ON_BENCH sem efeito; aguardandoDecisao é true na bancada e false fora; concluir encerra o pedido. Rodei: verde. MeusEquipamentosAprovacao.test.tsx e quemMexeNaOs.test.tsx: verdes. |
| EVIDÊNCIA | server/src/services/core/EquipmentPortalService.ts:689-698, :325 (aguardandoDecisao); server/src/services/core/WorkshopCoreService.ts:1767-1781; src/pages/gs/MeusEquipamentosPage.tsx:454; o balcão usa a mesma função (core.ts:9992-10004). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-183 — Kanban: dois operadores movendo a mesma OS — último grito vence, sem trava de versão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | Dois operadores moviam a mesma OS e os dois recebiam 200. A coluna final era a do último clique. |
| Causa | assumir, mover e largar nao conheciam o retrato que o cliente tinha da OS; o ultimo POST vencia |
| Correção | WorkshopOrderVersion (lerVersaoEsperada, exigirMesmaVersao): expectedStatus e expectedStatusChangedAt opcionais no corpo de assume/move/release; OS que mudou de coluna ou deu a volta A->B->A leva 409 CORE_ORDER_STALE dizendo onde esta e quem moveu por ultimo, antes de qualquer outra recusa e sem evento/comentario; pre-condicao malformada 400 CORE_ORDER_VERSION_INVALID; sem pre-condicao o contrato antigo vale. OficinaPage manda o retrato do card e, no 409, recarrega o quadro mantendo a mensagem; a ficha da OS manda o retrato no largar |
| DEPOIS | assume, move e release aceitam expectedStatus e expectedStatusChangedAt. Se a OS mudou, inclusive numa volta A→B→A, respondem 409 CORE_ORDER_STALE dizendo onde a OS está e quem a moveu por último, antes de qualquer outra recusa e sem gravar evento. O quadro sempre manda o retrato do card e, no 409, recarrega mantendo a mensagem. |
| Arquivos | server/src/services/core/WorkshopOrderVersion.ts, server/src/services/core/WorkshopCoreService.ts, server/src/routes/v1/core.ts, src/pages/gs/OficinaPage.tsx, src/pages/gs/OrdemServicoPage.tsx, server/tests/quadro-com-versao.test.ts, src/pages/gs/__tests__/quadroComVersao.test.tsx, src/pages/gs/__tests__/KanbanComSla.test.tsx |
| COMMIT | 48cf619 |
| TESTES | server/tests/quadro-com-versao.test.ts:115-250 (6 casos): o mecânico com retrato velho leva 409 e a OS fica onde o gerente pôs; A→B→A é 409; retrato em dia passa; sem retrato vale o contrato antigo; assumir concorrente; largar; pré-condição malformada é 400. Rodei: verde. quadroComVersao.test.tsx: verde. |
| EVIDÊNCIA | server/src/services/core/WorkshopOrderVersion.ts:66-136; server/src/services/core/WorkshopCoreService.ts:658, :782, :877; server/src/routes/v1/core.ts:9536, :9567, :9610; src/pages/gs/OficinaPage.tsx:527-545. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-184 — Fotos da OS (aparelho do cliente) servidas sem sessão em /uploads/os/<uuid>.<ext>

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / SECURITY_RISK |
| Empresa / frente | Oficina, Preço Justo / SEG |
| ANTES | As fotos da OS saíam sem sessão em /uploads/os/<uuid>.<ext>, por link público e perpétuo. |
| Causa | Foto de aparelho de cliente tratada como vitrine: a entropia do UUID era a unica protecao e o link nao expirava. |
| Correção | services/core/FotoDaOsAssinada.ts: a listagem da OS (sessao + alcance) devolve o caminho com ?e=<expira>&s=<HMAC-SHA256(nome, expira)>, chave derivada de DEVORA_JWT_SECRET com rotulo proprio, validade de 1 hora; o guarda na frente do express.static recusa sem assinatura, adulterada, de outra foto ou vencida (403 CORE_PHOTO_LINK_INVALID/EXPIRED) e poe Cache-Control private com o restante da validade. O banco continua guardando o caminho; a tela nao muda. |
| DEPOIS | Um guarda na frente do express.static exige ?e=&s= com HMAC-SHA256 (chave derivada de DEVORA_JWT_SECRET) e validade de 1 h. Recusa com 403 CORE_PHOTO_LINK_INVALID ou EXPIRED e manda Cache-Control private. Só a listagem autenticada da OS (e o POST) entrega o link assinado. As fotos de equipamento seguem a mesma régua. A tela monta o src com coreApi.imageUrl, que preserva a query. |
| Arquivos | server/src/services/core/FotoDaOsAssinada.ts, server/src/app.ts, server/src/routes/v1/core.ts, server/src/services/core/WorkshopPhotoService.ts, server/tests/foto-da-os-por-link-assinado.test.ts |
| COMMIT | 90fd2d2 |
| TESTES | server/tests/foto-da-os-por-link-assinado.test.ts (7 casos): sem assinatura 403; listagem sem token 401; o link da listagem abre com cache privado; assinatura adulterada 403; a assinatura de uma foto não abre outra; link vencido 403 EXPIRED; travessia de pasta barrada. Na primeira rodada, junto com outros 8 arquivos, o beforeAll estourou 30 s por carga. Rodado sozinho: 7/7 verdes. |
| EVIDÊNCIA | server/src/services/core/FotoDaOsAssinada.ts:55-58, :90-97, :103-125, :143-159; server/src/app.ts:253-261, :264-273; server/src/routes/v1/core.ts:9716-9718, :9749, :10517, :10547; src/lib/api/core.ts:4277; src/pages/gs/OrdemServicoPage.tsx:1281-1282. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-185 — uses_equipment_tags (quem usa plaquinha) só é gravado por migração — empresa/oficina nova exige desenvolvedor

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | Grupo (empresa nova de oficina) / OFI |
| ANTES | uses_equipment_tags só era gravado por migração. Uma oficina nova criada pela tela levava 409 CORE_COMPANY_NO_TAGS na primeira folha. |
| Causa | a marca que decide quem usa plaquinha nao tinha escritor na interface |
| Correção | CompanyTagSettings: POST /companies aceita usesEquipmentTags (booleano; ausente = padrao derivado da bancada: oficina de mobilidade usa, celular e loja nao; malformado 400 sem nada nascer) gravado na mesma transacao da criacao; PATCH /companies/:id/equipment-tags (quem responde pelo grupo e tem vinculo com a empresa) liga/desliga, recusando desligar com plaquinha gerada/disponivel no pool (CORE_COMPANY_TAGS_PENDING) e auditando company.equipment_tags.update nas duas empresas; GET /companies devolve usesEquipmentTags. EmpresasPage: coluna "Plaquinha com QR" com Ligar/Desligar e mensagens, tipo da primeira bancada e caixa "usa plaquinha" na criacao (padrao acompanha tipo e bancada, escolha manual vence), aviso do que o botao faz |
| DEPOIS | POST /companies aceita usesEquipmentTags. Sem escolha, o padrão vem da bancada (mobilidade usa; celular e loja não); valor malformado é 400 e nada é criado. A marca é gravada na mesma transação da empresa. PATCH /companies/:id/equipment-tags liga e desliga, só para quem responde pelo grupo, recusa desligar com adesivos no pool e audita nas duas empresas. EmpresasPage tem a caixa na criação e a coluna com Ligar/Desligar. |
| Arquivos | server/src/services/core/CompanyTagSettings.ts, server/src/routes/v1/core.ts, src/lib/api/empresaPlaquinha.ts, src/lib/api/core.ts, src/pages/gs/EmpresasPage.tsx, server/tests/plaquinha-pela-tela.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/plaquinhaPelaTela.test.tsx |
| COMMIT | 8a4b7a1 |
| TESTES | server/tests/plaquinha-pela-tela.test.ts:67-218: a oficina de mobilidade nasce com a marca e o gerente gera lote (201); celular e loja nascem sem; a escolha explícita vence o padrão; 'sim' é 400 sem empresa nova; liga e desliga com auditoria; desligar com pool é 409 CORE_COMPANY_TAGS_PENDING; gerente da operação 403; empresa inexistente 404. Rodei: verde. plaquinhaPelaTela.test.tsx: verde. |
| EVIDÊNCIA | server/src/services/core/CompanyTagSettings.ts:37-114; server/src/routes/v1/core.ts:8827-8859, :8943-8973, :8812; src/pages/gs/EmpresasPage.tsx:176, :230-249, :364-377, :509-527. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-186 — Rotas de escrita da OS (comments, parts, labor, complete, pedir-aprovacao, photos) usam resolveWorkshop(req,false) e perdem o recorte de bancada para mecânico de 2+ bancadas

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Preço Justo (se ganhar 2ª bancada); hoje sem efeito (1 bancada por empresa) / OFI |
| ANTES | As rotas de escrita comments, parts, labor, pedir-aprovacao e complete usavam resolveWorkshop(req,false). O mecânico de 2 ou mais bancadas escrevia em OS de uma terceira. |
| Causa | a regua antiga devolvia nulo para quem atende mais de uma bancada, e nulo em requireScopedOrder e a empresa inteira |
| Correção | as cinco portas passam a usar resolveWorkshopScope(req), a mesma lista da leitura, assuncao, movimento e plano; a devolucao de peca (GAP-PRD-103) tambem |
| DEPOIS | As cinco rotas passam resolveWorkshopScope(req) ao serviço; photos já usava. Das seis portas da ficha, nenhuma usa mais resolveWorkshop(req,false). O único uso que resta é o GET /equipment (core.ts:10229), que é leitura e está fora da ficha. |
| Arquivos | server/src/routes/v1/core.ts, server/tests/quem-mexe-na-os.test.ts |
| COMMIT | c699bcf |
| TESTES | server/tests/quem-mexe-na-os.test.ts:329-414: o mecânico vinculado a A e B leva 404 CORE_ORDER_NOT_FOUND nas cinco portas numa OS da bancada C, sem efeito (labor, status, approval e comentários intactos); nas bancadas dele as mesmas portas funcionam. Rodei: verde. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:9869 (comments), :9890 (parts), :9922 (labor), :9948 (pedir-aprovacao), :10032 (complete), :9730 (photos). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-187 — Coluna do Kanban corta as OS mais antigas quando passa de 60 cards e não oferece 'ver mais'

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Oficina, Preço Justo / OFI |
| ANTES | Cada coluna do Kanban pedia 60 OS por number DESC. Acima de 60, as mais antigas sumiam do quadro, sem 'ver mais'. |
| Causa | a coluna pedia as 60 de numero mais alto; acima de 60 as mais antigas (SLA estourado) ficavam fora do quadro |
| Correção | searchOrders ganhou ordem=quadro (prioridade urgente->baixa e a mais antiga primeiro, a mesma ordem do card), lida por GET /workshop/orders?ordem=quadro; a lista padrao segue number DESC. OficinaPage: colunas de trabalho pedem ordem=quadro, botao "Carregar mais N de M" por coluna (offset, deduplicado, entra no fim da coluna), recarregamento depois de mover pede o que a coluna ja mostrava (ate 300) e reinicia ao trocar o filtro; finalizadas pelas mais recentes |
| DEPOIS | GET /workshop/orders?ordem=quadro ordena por prioridade e depois pela mais antiga, com offset. As colunas de trabalho pedem ordem=quadro, têm o botão 'Carregar mais N de M', e o recarregamento mantém o que já estava carregado. As finalizadas continuam pelas mais recentes. |
| Arquivos | server/src/services/core/WorkshopCoreService.ts, server/src/routes/v1/core.ts, src/pages/gs/OficinaPage.tsx, server/tests/quadro-com-versao.test.ts, src/pages/gs/__tests__/quadroComVersao.test.tsx |
| COMMIT | 48cf619 |
| TESTES | server/tests/quadro-com-versao.test.ts:252-310: com 70 OS, a primeira página traz as 60 mais antigas e a segunda as 10 restantes sem repetir; urgente antes de média; sem ordem=quadro segue DESC. Rodei: verde. quadroComVersao.test.tsx (Carregar mais, limit=70 no recarregamento): verde. |
| EVIDÊNCIA | server/src/services/core/WorkshopCoreService.ts:2010, :2028-2036; server/src/routes/v1/core.ts:9376-9379; src/pages/gs/OficinaPage.tsx:339-347, :371-379, :457, :1255-1262. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-188 — OS legada #1 no banco real fora das regras atuais (sem oficina, sem responsável, evento finalizada→em_andamento)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DATA_INTEGRITY_RISK |
| Empresa / frente | Oficina / INT |
| ANTES | A OS #1 do banco real estava em_andamento sem oficina e sem responsável, com evento finalizada→em_andamento. O card fantasma aparecia no quadro e não havia conserto pela tela. |
| Causa | a porta de assumir nao guardava a situacao (origem do evento finalizada->em_andamento), e o dado antigo sem bancada/responsavel nao tinha caminho de correcao alem de SQL |
| Correção | assumeOrder recusa OS aguardando_pagamento/finalizada (CORE_ORDER_PAST_BOARD) e a OS que ja e do tecnico fora de em_aberto (CORE_ORDER_ALREADY_YOURS); OS de coluna de trabalho sem responsavel ainda se assume (nota "estava sem responsavel"). irregularidadesDaOs (sem_bancada, sem_responsavel) calculada no quadro e na ficha. WorkshopOrderRegularization + POST /workshop/orders/:id/regularizar (gerente da oficina): destino quadro (ganha a unica bancada ou a escolhida, volta para em_aberto com evento) ou encerrar como lancamento indevido (finalizada sem custo, no_cost_reason lancamento_indevido, so sem peca/mao de obra/venda e ainda na bancada); motivo obrigatorio, comentario de gestor, auditoria workshop.order.regularize com antes/depois, evento para a central. Tela: aviso "Fora das regras" no card do quadro com link; RegularizarOsCard na ficha da OS (bancada quando ha mais de uma, encerrar desabilitado com dinheiro, mecanico ve o aviso sem o formulario); A4 traduz o motivo |
| DEPOIS | O código está completo. assumeOrder recusa OS aguardando_pagamento ou finalizada (CORE_ORDER_PAST_BOARD) e reassumir a própria (CORE_ORDER_ALREADY_YOURS). O quadro e a ficha mostram 'Fora das regras'. POST /regularizar (gerente_oficina, motivo obrigatório, auditoria) devolve ao quadro ou encerra como lançamento indevido. Mas o dado real não foi tocado: pelo próprio gaps.json, a OS #1 continua no quadro até o dono decidir pela tela. Por isso o rótulo RESOLVED_PROVEN exagera. |
| Arquivos | server/src/services/core/WorkshopCoreService.ts, server/src/services/core/WorkshopOrderVersion.ts, server/src/services/core/WorkshopOrderRegularization.ts, server/src/services/core/ServiceOrderA4.ts, server/src/routes/v1/core.ts, src/pages/gs/OficinaPage.tsx, src/pages/gs/OrdemServicoPage.tsx, src/components/gs/RegularizarOsCard.tsx, src/lib/api/oficinaQuadro.ts, server/tests/quadro-com-versao.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/quadroComVersao.test.tsx, src/pages/gs/__tests__/regularizarOs.test.tsx, docs/audits/remediacao/migracoes/OFI.md |
| COMMIT | 48cf619 |
| TESTES | server/tests/quadro-com-versao.test.ts:311-525 (blocos 188): não reassume finalizada nem OS da fila do caixa; irregularidades no quadro e na ficha; regularizar para o quadro com evento e auditoria; encerrar como indevido, recusado quando há mão de obra; recusas 403/400/409/404; OS sem responsável ainda se assume. Rodei: verde. regularizarOs.test.tsx e quadroComVersao.test.tsx: verdes. |
| EVIDÊNCIA | server/src/services/core/WorkshopCoreService.ts:668-693; server/src/services/core/WorkshopOrderRegularization.ts:106-250; server/src/services/core/WorkshopOrderVersion.ts:161-172; server/src/routes/v1/core.ts:9631-9649; src/pages/gs/OrdemServicoPage.tsx:946 (RegularizarOsCard). |
| Veredito independente | PARCIAL (contraprova concorda) — contraprova: concorda (OWNER_DECISION_REQUIRED) |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| O que falta | Nenhuma linha de código. A ficha trata de um dado: a OS #1 do banco real, que está em em_andamento sem bancada e sem responsável. A correção que ela recomenda é limpar esse dado antes do go-live. O código agora oferece esse conserto pela tela, e também fecha a porta que criou o evento finalizada→em_andamento. Ainda falta alguém executar o conserto na loja. Depois do deploy de int/b, o gerente da oficina (ou o Emanuel com esse perfil) abre /sistema/oficina/os/<id da OS #1>, clica em Regularizar, escolhe 'Devolver ao quadro' ou 'Encerrar como lançamento indevido' e informa o motivo. 'Encerrar' só é aceito se a OS não tiver peça, mão de obra nem venda; se a loja tiver mais de uma bancada, a tela pede para escolher. Os eventos antigos finalizada→em_andamento continuam na linha do tempo de propósito (histórico só-acréscimo), e a regularização entra como mais um passo. O gaps.json marca a ficha como RESOLVED_PROVEN, o que exagera: a causa no código está resolvida, mas o objeto da ficha, o dado real, só se resolve com essa decisão. Por isso fico com OWNER_DECISION_REQUIRED, como o auditor. Não abri o banco da loja; a própria revalidação do gaps.json registra, por leitura readOnly, que a OS #1 continua lá, e pendente_externo diz que nada foi aplicado. |
| Insumo externo | Emanuel ou o gerente da oficina: abrir a OS #1 e escolher, pela tela, 'devolver ao quadro' ou 'encerrar como lançamento indevido', com motivo. Não abri o banco da loja para confirmar que a OS #1 ainda está lá; o gaps.json diz que nada foi aplicado. |

### GAP-PRD-189 — POST /equipment/:id/owner registra venda À MÃO de plaquinha interna ainda não adotada — SOLD sem venda, sem financeiro, sem fiscal — e a moto some das vinculáveis enquanto continua in_stock na PJ

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 — ajuste P2→P3 (fase 2) / DATA_INTEGRITY_RISK (após refutação: P3 / DATA_INTEGRITY_RISK) |
| Empresa / frente | PJ Motors, Oficina / OFI |
| ANTES | POST /equipment/:id/owner gravava SOLD à mão numa plaquinha INTERNAL_PJ_MOTORS com a moto ainda in_stock na PJ: sem venda, sem financeiro, sem fiscal e sem caminho de volta. |
| Causa | o registro a mao nao perguntava se a moto ainda estava no patio de uma loja do grupo |
| Correção | assignOwner recusa a plaquinha interna cujo chassi, motor ou serie esta in_stock numa loja do grupo (CORE_EQUIPMENT_SALE_BY_PDV nomeando loja e produto), recusa saleId que nao existe na empresa (CORE_SALE_NOT_FOUND) e o evento distingue registro a mao de venda; o legado tem volta: EquipmentManualSale.desfazerVendaAMao + POST /equipment/:id/owner/desfazer (gerente_oficina, motivo obrigatorio, so INTERNAL SOLD sem sale_id e sem unidade vinculada; volta a NOT_SOLD sem dono, evento sale_reverted com motivo e dono anterior, auditoria equipment.sale.manual_undo, token fora da resposta); GET /equipment/:id devolve vendaAMao; a ficha mostra o cartao Venda registrada a mao (o gerente desfaz, o mecanico ve o aviso) |
| DEPOIS | assignOwner recusa com CORE_EQUIPMENT_SALE_BY_PDV (nomeando loja e produto) quando o chassi, motor ou série está in_stock numa loja do grupo, e recusa saleId inexistente na empresa (CORE_SALE_NOT_FOUND). O legado se desfaz por POST /equipment/:id/owner/desfazer (gerente_oficina, motivo, evento sale_reverted, auditoria equipment.sale.manual_undo, token fora da resposta). A ficha mostra o VendaAMaoCard. |
| Arquivos | server/src/services/core/EquipmentService.ts, server/src/services/core/EquipmentManualSale.ts, server/src/routes/v1/core.ts, src/components/gs/VendaAMaoCard.tsx, src/pages/gs/EquipamentoFichaPage.tsx, src/lib/api/fronteiraOficina.ts, server/tests/fronteira-pj-oficina.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/fronteiraPjOficina.test.tsx, docs/audits/remediacao/migracoes/OFI.md |
| COMMIT | e5230fd |
| TESTES | server/tests/fronteira-pj-oficina.test.ts:184-294: moto no pátio recusa e a plaquinha fica NOT_SOLD e continua vinculável; moto antiga sem unidade aceita; saleId inventado dá 404; desfazer com motivo volta a NOT_SOLD, com evento e auditoria, e o segundo desfazer dá 409; venda real não se desfaz. Rodei: verde. fronteiraPjOficina.test.tsx (bloco 189): verde. |
| EVIDÊNCIA | server/src/services/core/EquipmentService.ts:1098-1122; server/src/routes/v1/core.ts:10576-10646; src/pages/gs/EquipamentoFichaPage.tsx:392-393; src/components/gs/VendaAMaoCard.tsx. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-190 — Reimpressão da plaquinha da moto da PJ só pela Oficina: /labels/equipment e /sheet buscam o equipamento pela empresa da sessão

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | PJ Motors / OFI |
| ANTES | /labels/equipment e /sheet procuravam o equipamento pela empresa da sessão, e a PJ não conseguia reimprimir a plaquinha da moto que vende. |
| Causa | o equipamento vive na Oficina e as rotas de impressao so procuravam na empresa da sessao |
| Correção | UnitTagReprint + POST /units/:id/equipment/sheet (gerente_loja, gerente_oficina, estoquista): a autorizacao e a unidade da sessao (404 se nao for dela), a plaquinha vem do vinculo (nenhum id de equipamento do corpo), exige a empresa com plaquinha e a bancada com QR; folha com o layout e o nome da empresa DONA da plaquinha, mesmo numero e mesmo token (reimprimir nao troca), evento label_printed no historico da maquina e auditoria unit.equipment.label.reprint; token fora do JSON. UnidadesEstoquePage: botao "Reimprimir plaquinha" na celula da plaquinha |
| DEPOIS | POST /units/:id/equipment/sheet (gerente_loja, gerente_oficina, estoquista) autoriza pela unidade da sessão (404 se a unidade não é dela) e lê a plaquinha pelo vínculo, sem id vindo do corpo. A folha sai com o mesmo número e o mesmo QR, no layout da empresa dona. Grava evento label_printed na Oficina e auditoria na PJ. A tela de Unidades tem o botão 'Reimprimir plaquinha'. |
| Arquivos | server/src/services/core/UnitTagReprint.ts, server/src/routes/v1/core.ts, src/lib/api/plaquinhaDaMaquina.ts, src/pages/gs/UnidadesEstoquePage.tsx, server/tests/plaquinha-pela-tela.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/__tests__/plaquinhaPelaTela.test.tsx |
| COMMIT | 8a4b7a1, b18409d |
| TESTES | server/tests/plaquinha-pela-tela.test.ts:223-360: a rota antiga não acha; pela unidade saem o mesmo rótulo e o mesmo token, sem o token no JSON, com evento na Oficina e auditoria na PJ; recusas 409 sem plaquinha, 404 outra loja, 403 caixa, 409 loja sem a marca. Rodei: verde. plaquinhaPelaTela.test.tsx (bloco 190): verde. |
| EVIDÊNCIA | server/src/services/core/UnitTagReprint.ts:45-130 (JOIN com w.company_id = e.company_id na linha 68); server/src/routes/v1/core.ts:11631-11664; server/src/services/core/EquipmentStockLink.ts:438-441; src/pages/gs/UnidadesEstoquePage.tsx:399-424, :996-998. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-191 — Checkout via API sem CPF/e-mail cria pedido e reserva com cobrança 'failed' — 25h de estoque preso sem como pagar

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | todas / ECO |
| ANTES | POST /loja/checkout só com customerName devolvia 201, com cobrança 'failed' e o estoque reservado por 25 h. |
| Causa | O caminho do visitante não conferia documento nem e-mail antes de reservar; a cobrança online (que exige CPF/CNPJ) só falhava depois, com o pedido e a reserva já criados. |
| Correção | CheckoutIdentityService.conferirVisitante: nome de pessoa, CPF/CNPJ com dígito verificador (documentoValido) e e-mail sintaticamente válido (PoliticaDoCadastro.emailValido), conferidos na rota ANTES de cotar frete, reservar ou numerar; recusa 400 CHECKOUT_VISITANTE_INCOMPLETO nomeando todos os campos em details.campos. O pedido do visitante guarda o documento só com dígitos e o e-mail normalizado. Tela: e-mail obrigatório no formulário do visitante; a recusa do servidor aparece com as palavras dele. PoliticaDoCadastro (novo) concentra as regras de e-mail, nome e senha usadas também no GAP-PRD-192. |
| DEPOIS | O visitante é conferido na rota antes de cotar frete, reservar ou numerar. Nome, CPF/CNPJ com dígito verificador e e-mail sintático são obrigatórios. A recusa é 400 CHECKOUT_VISITANTE_INCOMPLETO e lista todos os campos. A tela exige o e-mail. |
| Arquivos | server/src/services/core/PoliticaDoCadastro.ts, server/src/services/core/CheckoutIdentityService.ts, server/src/routes/v1/storefront.ts, server/tests/checkout-visitante-confere-dados.test.ts, server/tests/helpers/lojaAberta.ts, server/tests/ecommerce-core.test.ts, server/tests/audit-ecommerce.test.ts, server/tests/loja-frete-checkout.test.ts, server/tests/reserva-de-pedido-expira.test.ts, server/tests/frete-de-cada-loja.test.ts, src/pages/gs/LojaPage.tsx, src/pages/gs/__tests__/LojaPage.test.tsx |
| COMMIT | dbb2fe2 |
| TESTES | server/tests/checkout-visitante-confere-dados.test.ts: só nome = 400 com campos ['documento','email'], 0 pedidos, reserva 0, fila de e-mail 0; CPF com dígito errado e 000.000.000-00 recusados; e-mails inválidos recusados sem reserva; os três campos juntos; CPF e CNPJ válidos = 201, reserva 1, documento só com dígitos. Tela: LojaPage.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/storefront.ts:682-689 (conferirVisitante antes de resolverFretesDoCarrinho, na linha 738, e da reserva); server/src/services/core/CheckoutIdentityService.ts:372-399; server/src/services/core/PoliticaDoCadastro.ts:34-46 (emailValido); src/pages/gs/LojaPage.tsx:1065-1073 (e-mail required). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-192 — Cadastro manual: sem nome, sem confirmação de senha, força = só 8 caracteres, sem rate limit próprio do registro

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / PARTIAL_IMPLEMENTATION |
| Empresa / frente | todas / ECO |
| ANTES | O registro não tinha nome nem confirmação de senha. A força da senha era só 8 caracteres, o e-mail só precisava de '@', e havia apenas o limite global de 300/min. |
| Causa | registerCustomerAccount não recebia nome; a validação era "contém @" e 8 caracteres; não havia teto por origem na porta de cadastro. |
| Correção | Servidor: conferirCadastro no registro manual e no do convite — e-mail sintático (PoliticaDoCadastro.exigirEmailValido); nome de pessoa quando veio (branco ou mais de 120 caracteres = 400 PORTAL_INVALID_NAME), guardado em core_customer_accounts.name (o convite sem nome usa o nome do cadastro que a loja fez); senha pela política única (8 a 128, fora da lista das mais usadas no mundo e no Brasil, sem sequência ou repetição, não o próprio e-mail), aplicada também na troca logada e na redefinição pelo link (a recusa não gasta o link). Teto de cadastros por origem: 10 por hora (429 PORTAL_LIMITE_CADASTRO com details.tenteEmMinutos), contado no banco por PortalLimiteService (core_portal_limites: SHA-256 da origem, sem IP cru, poda de 24 h; sobrevive a reinício); validação recusada não gasta o teto, e-mail já cadastrado (409) gasta. Origem = req.ip, a mesma do limite global (DEVORA_TRUST_PROXY é decisão do dono). Tetos ajustáveis por ambiente (DEVORA_PORTAL_CADASTROS_POR_ORIGEM_HORA). Tela: Nome e "Confirme a senha" no criar conta (conferidos antes de enviar); confirmação também na redefinição pelo link e na troca de senha (SenhaNovaComConfirmacao, lib/senhaNova). |
| DEPOIS | O registro confere e-mail sintático, nome (400 PORTAL_INVALID_NAME, gravado em core_customer_accounts.name) e a senha pela política única (8–128, lista de comuns, sequência/repetição, não o e-mail). Há teto de 10 cadastros por origem/hora, gravado no banco (429 PORTAL_LIMITE_CADASTRO), e teto próprio em /portal/recuperar-senha. A tela pede nome e 'Confirme a senha'. |
| Arquivos | server/src/services/core/PoliticaDoCadastro.ts, server/src/services/core/PortalLimiteService.ts, server/src/services/core/CustomerPortalService.ts, server/src/services/core/CustomerAccountService.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/cadastro-manual-completo.test.ts, server/tests/carteiro-existe.test.ts, src/lib/senhaNova.ts, src/components/gs/SenhaNova.tsx, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/RedefinirSenhaPage.tsx, src/components/gs/ContaDoCliente.tsx, src/components/gs/__tests__/cadastroManualCompleto.test.tsx, src/pages/gs/__tests__/MinhaContaPage.test.tsx, src/components/gs/__tests__/ContaDoCliente.test.tsx |
| COMMIT | bda3ca3 |
| TESTES | server/tests/cadastro-manual-completo.test.ts: nome gravado e lido com nameSource 'conta'; nome em branco ou longo = 400 sem criar conta; 7 e-mails inválidos = 400; senhas comuns e triviais = 400 PORTAL_WEAK_PASSWORD; e-mail como senha recusado; troca e redefinição com a mesma regra; 11º cadastro da mesma origem = 429 e só 10 contas; 409 conta no teto; validação recusada não conta; o banco guarda o hash, nunca o IP. Tela: cadastroManualCompleto.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CustomerPortalService.ts:318-337 (conferirCadastro), 355-366 e 534-539 (consumirLimite no registro e no convite), 413 (nome gravado), 1034-1041 (teto da recuperação); server/src/services/core/PortalLimiteService.ts:50-73, 98-144 (SHA-256 da origem, 429 com tenteEmMinutos); server/src/services/core/PoliticaDoCadastro.ts:99-176; server/src/routes/v1/storefront.ts:877-928, 1520-1523 (origemDaRequisicao); src/pages/gs/MinhaContaPage.tsx:686-693, 762-775, 806-813. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Opcional: atrás de proxy reverso, Emanuel precisa declarar DEVORA_TRUST_PROXY ou subir DEVORA_PORTAL_CADASTROS_POR_ORIGEM_HORA; senão o teto vale para a loja inteira. É configuração já prevista; não falta código. O nome é obrigatório na tela e opcional na API, como declarado; a conta sem nome não fecha pedido. |

### GAP-PRD-193 — Carrinho vive só no localStorage: não persiste entre dispositivos nem funde no login; sessão do portal expira em 1h fixa

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | todas / ECO |
| ANTES | O carrinho vivia só no localStorage, sem persistir entre aparelhos nem fundir no login. A sessão do portal expirava em 1 h fixa, sem renovação. |
| Causa | O carrinho foi desenhado para a vitrine anônima e a sessão do portal para consulta curta; com a conta obrigatória, os dois passaram a atrapalhar a compra (trocar de aparelho perde o carrinho; a conta cai no meio da navegação). |
| Correção | Servidor: core_customer_cart_items + CarrinhoDaContaService — só produto e quantidade (preço e disponível da vitrine a cada leitura); GET/PUT /loja/portal/carrinho, POST /carrinho/mesclar (login: mesmo produto = a MAIOR quantidade, nunca a soma), POST /carrinho/itens (acrescenta); produto que saiu da vitrine ou modelo de grade volta em descartados e sai do carrinho; teto de 60 linhas e 99 unidades; o pedido fechado com conta tira da conta o que foi comprado. Sessão deslizante em resolveCustomerSession: cada uso empurra o vencimento para 1 h (escrita no máximo a cada 5 min) até o teto de 24 h desde o login; GET /loja/portal/sessao devolve expiresAt e absoluteExpiresAt. Tela: useCarrinhoDaConta na vitrine (entrar funde a cópia do aparelho, ou lê o servidor se a cópia já é desta conta — marcador gs.loja.carrinho.conta; cada mudança vai para a conta; aviso dos descartados); a página do produto acrescenta também na conta; useRenovacaoDaSessao na casca da loja (renova por uso, no máximo a cada 5 min; 401 limpa a sessão); o "Sair" da casca passou a encerrar a sessão NO SERVIDOR (antes só apagava o localStorage) e, como o de Minha conta, leva embora a cópia do carrinho da conta; sessão que vence não apaga o carrinho. |
| DEPOIS | A conta tem carrinho no servidor (GET/PUT, mesclar pela maior quantidade, itens), com preço vivo e descartados. A sessão desliza 1 h por uso até o teto de 24 h. A vitrine funde no login e envia as mudanças, a casca renova a sessão, e o 'Sair' encerra a sessão no servidor. O visitante segue com o carrinho do navegador. |
| Arquivos | server/src/services/core/CarrinhoDaContaService.ts, server/src/services/core/CustomerPortalService.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/carrinho-da-conta.test.ts, src/lib/api/carrinho.ts, src/lib/carrinhoLocal.ts, src/hooks/useCarrinhoDaConta.ts, src/hooks/useRenovacaoDaSessao.ts, src/components/gs/CascaDaLoja.tsx, src/pages/gs/LojaPage.tsx, src/pages/gs/ProdutoLojaPage.tsx, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/__tests__/carrinhoDaConta.test.tsx |
| COMMIT | 525f851 |
| TESTES | server/tests/carrinho-da-conta.test.ts (14): dois aparelhos leem o mesmo carrinho; o preço não congela; a fusão fica com a maior quantidade; descartados; teto de 99 e lista torta = 400; uma conta não lê a outra; sem sessão = 401; o pedido tira o comprado; o uso empurra o vencimento para mais de 55 min; nunca passa de 24 h; sessão vencida ou revogada = 401. Tela: carrinhoDaConta.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/storefront.ts:1450-1498; server/src/services/core/CustomerPortalService.ts:656-717 (renovação deslizante com teto); server/src/services/core/CarrinhoDaContaService.ts:34-35, 61, 170-184; src/hooks/useCarrinhoDaConta.ts:71-98; src/pages/gs/LojaPage.tsx:352; src/components/gs/CascaDaLoja.tsx:83, 117. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-194 — Promoções: sem edição, sem horário, sem prioridade/limite; sobreposição resolve pelo menor preço (documentado)

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / ECO |
| ANTES | PATCH/PUT /core/promotions/:id respondia 404 e não havia horário nem teto de unidades. Mudar uma promoção era encerrar e recriar. |
| Causa | Modelo de promoção sem edição, horário e estoque promocional; a decisão era do dono, e o software não oferecia o mecanismo. |
| Correção | Mecanismo implementado com o padrão que já valia. EDIÇÃO: PATCH /core/promotions/:id (gerente_loja), mesma conferência da criação sobre o registro inteiro, 409 CORE_PROMOTION_ENDED em promoção encerrada, trilha promotion.update com {mudancas: campo → {de, para}}. HORÁRIO: starts_time/ends_time HH:MM no relógio da loja (horaDaLoja), início inclusivo e fim exclusivo, sem atravessar a meia-noite (400 CORE_PROMOTION_HOURS). ESTOQUE PROMOCIONAL: max_units, consumo contado pelas linhas que gravam promotion_id (core_sale_items — toque mínimo no SalesService — e core_order_items), venda/pedido cancelado devolve; a linha inteira precisa caber no saldo, senão sai sem aquela promoção; a vitrine para de anunciar quando esgota. PRIORIDADE: não implementada por decisão fundamentada — sobreposição resolve pelo MENOR preço (a oferta anunciada obriga a loja, CDC art. 30 e 35); a criação/edição devolve `sobreposicoes` e a tela avisa. Tela: Editar, campos de horário e limite, colunas "Dias · horário", "N de M un.", selos Esgotada/Fora do horário. |
| DEPOIS | PATCH /core/promotions/:id (gerente_loja) passa pela mesma conferência, com 409 para promoção encerrada e trilha promotion.update {de, para}. Há faixa de horário HH:MM no relógio da loja e max_units consumido nos dois canais, com o cancelado devolvendo. A sobreposição resolve pelo menor preço e o servidor avisa em 'sobreposicoes'. A tela tem Editar, horário, limite e os selos Esgotada / Fora do horário. |
| Arquivos | server/src/services/core/PromotionService.ts, server/src/services/core/PricingService.ts, server/src/services/core/SalesService.ts, server/src/services/core/StorefrontService.ts, server/src/routes/v1/core.ts, server/src/routes/v1/storefront.ts, server/src/db/schema.ts, server/tests/promocao-edicao-horario-limite.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/pages/gs/PromocoesPage.tsx, src/lib/api/promocoes.ts, src/pages/gs/__tests__/promocoesValidadas.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 5d910f9, 9d51033 |
| TESTES | server/tests/promocao-edicao-horario-limite.test.ts (11): edição muda o preço com a trilha de/para; 150% = 400; troca de alvo; encerrada = 409; outra empresa = 404; início inclusivo e fim exclusivo; CORE_PROMOTION_HOURS; saldo por linha e cancelar devolve; o balcão consome o mesmo saldo; teto <= 0 = 400; sobreposição avisada e menor preço. Tela: promocoesValidadas.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:13428-13453; server/src/services/core/PromotionService.ts:381-401 (horário e teto), 518-576 (editarPromocao, companyId, 409); server/src/services/core/PricingService.ts:126-134 (unidadesUsadasSql), 318-332 e 402-419 (horário da loja e saldo); src/pages/gs/PromocoesPage.tsx:160, 171, 261-306, 343, 494-506, 633; src/lib/api/promocoes.ts:76 (PATCH). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Nenhum para o que a correção recomendada pede (PATCH, horário, limite). Prioridade entre promoções não foi implementada, com fundamento declarado (menor preço, CDC arts. 30 e 35); se Emanuel ainda assim a quiser, seria código novo. Limitação declarada: duas linhas do mesmo produto numa venda de balcão podem passar do teto em uma linha. |

### GAP-PRD-195 — PUT /core/shipping-settings aceita prazo estimado negativo

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | Todas / ECO |
| ANTES | PUT /core/shipping-settings com estimatedDays:-3 devolvia 200 e gravava o valor negativo. |
| Causa | estimatedDays não tinha validação nenhuma no serviço; a tela mandava Number(texto), e texto não numérico virava NaN, que o JSON serializa como null (apagava o prazo em silêncio). |
| Correção | saveShippingSettings recusa com 400 SHIPPING_INVALID_DAYS tudo que não for inteiro de 0 a PRAZO_MAXIMO_EM_DIAS=365 (negativo, fracionado, texto, booleano, absurdo), antes de gravar; nulo continua 'sem prazo'. EntregaLojaPage confere o campo (só dígitos) antes de chamar o servidor, mostra a recusa e envia o número já aparado; o texto de ajuda diz 'Número inteiro'. |
| DEPOIS | saveShippingSettings recusa com 400 SHIPPING_INVALID_DAYS tudo o que não for inteiro de 0 a 365, antes de gravar; nulo continua valendo. A tela confere só dígitos antes de enviar. |
| Arquivos | server/src/services/core/CheckoutShippingService.ts, src/pages/gs/EntregaLojaPage.tsx, src/pages/gs/__tests__/EntregaLojaPage.test.tsx, server/tests/prazo-de-entrega-valido.test.ts |
| COMMIT | f7a4caf |
| TESTES | server/tests/prazo-de-entrega-valido.test.ts: -3, -1, 2.5, '3', texto, 366, MAX_SAFE_INTEGER e true = 400 SHIPPING_INVALID_DAYS, com o valor gravado continuando 4; 0, inteiros e null = 200. Tela: EntregaLojaPage.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CheckoutShippingService.ts:97, 132-143; src/pages/gs/EntregaLojaPage.tsx:78, 95, 222. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-196 — deliveryEstimate conta dias úteis com getDay() do fuso do servidor, não do dia da loja

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | Todas / ECO |
| ANTES | deliveryEstimate usava new Date, setDate e getDay() do fuso do processo. A data prometida mudava ±1 dia na fronteira das 21h às 0h. |
| Causa | deliveryEstimate somava dias com new Date(dispatchedAt), setDate e getDay() — o relógio do processo — e devolvia o instante (toISOString) em vez do dia; o resto do domínio já usa o calendário da loja. |
| Correção | deliveryEstimate usa somarDiasUteis(diaDaLoja(dispatchedAt), Math.ceil(dias)) do novo DiasUteis (fim de semana e feriado bancário nacional fora) e devolve o dia de calendário AAAA-MM-DD, documentado na interface. A tela (MinhaContaPage → dataBR) já reescreve data de calendário sem converter (src/lib/datas.ts:96-99), então nenhuma mudança de tela foi necessária. |
| DEPOIS | A data prometida é somarDiasUteis(diaDaLoja(dispatchedAt), ceil(dias)), no calendário da loja e sem fim de semana nem feriado nacional. Devolve o dia AAAA-MM-DD. |
| Arquivos | server/src/services/core/CustomerPortalService.ts, server/src/services/core/DiasUteis.ts, server/tests/prazo-no-calendario-da-loja.test.ts, server/tests/loja-prazo-entrega.test.ts |
| COMMIT | f7a4caf |
| TESTES | server/tests/prazo-no-calendario-da-loja.test.ts: com process.env.TZ em UTC, America/Sao_Paulo e Asia/Tokyo — quinta 21h30 +1 = sexta 2026-08-14; domingo 21h30 +1 = segunda 2026-08-17; sexta +3 = quarta; o feriado de 07/09 é pulado. Também loja-prazo-entrega.test.ts. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CustomerPortalService.ts:53-54 (imports), 1358-1374; server/src/services/core/DiasUteis.ts:79-84 (ehDiaUtil), 102-113 (somarDiasUteis). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-197 — Promoção aceita product_id de outra empresa (201) — inofensivo no preço, mas grava FK cruzada entre tenants

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / ECO |
| ANTES | O gerente da Gringa criava promoção com o productId de um produto do PJ (201), gravando uma FK cruzada entre tenants. |
| Causa | A rota não conferia que o produto pertence à empresa do token. |
| Correção | Toda busca de resolverProduto leva company_id: produto de outra empresa responde 404 igual a código inexistente (não revela o que a outra empresa tem). PATCH confere de novo. A lista devolve product_name nulo e o problema "O produto não é desta empresa ou foi removido" para a linha legada (LEFT JOIN por id E empresa); a tela a mostra como "Produto de outra empresa ou removido" + "Inválida", com Encerrar. |
| DEPOIS | resolverProduto busca por id, código interno e códigos de barras sempre com o company_id do token. Produto de outra empresa = 404 CORE_PROMOTION_PRODUCT_NOT_FOUND, igual a inexistente. O PATCH passa pela mesma conferência. A linha legada cruzada aparece na lista com um aviso e a tela mostra 'Produto de outra empresa ou removido'. |
| Arquivos | server/src/services/core/PromotionService.ts, server/tests/promocao-validada.test.ts, src/pages/gs/PromocoesPage.tsx, src/pages/gs/__tests__/promocoesValidadas.test.tsx, docs/audits/remediacao/migracoes/ECO.md |
| COMMIT | 5d910f9, 9d51033 |
| TESTES | server/tests/promocao-validada.test.ts:299-329: id do produto do PJ na Gringa = 404 e nada gravado; código do PJ não acha nada na Gringa; o PJ cria no próprio produto = 201; a linha legada mostra o problema. Também promocao-edicao-horario-limite.test.ts:145 (edição de outra empresa = 404). Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/PromotionService.ts:158-184 (todas as buscas com company_id), 316 (conferir), 481 (criar), 543 (editar), 594-601 e 634 (problema da linha legada, LEFT JOIN por empresa); server/src/routes/v1/core.ts:13389-13401 (companyId de scope(req)); src/pages/gs/PromocoesPage.tsx:72. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_BY_ROOT_CAUSE** — Resolvido pela causa-raiz |
| Insumo externo | Não verifiquei se o banco real tem linhas legadas cruzadas. O SQL para encerrá-las está em docs/audits/remediacao/migracoes/ECO.md, e a tela também permite encerrar. |

### GAP-PRD-198 — POST /core/emails/enviar do gerente de uma empresa entrega a fila das seis; FROM único do ambiente sem remetente/assinatura por empresa

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / OWNER_DECISION_REQUIRED |
| Empresa / frente | Todas / EML |
| ANTES | POST /core/emails/enviar do gerente de uma empresa entregava a fila das seis. Havia um só EMAIL_FROM, sem remetente nem assinatura por empresa. |
| Causa | O flush manual herdou o escopo do worker (as seis) e o remetente era só do ambiente. |
| Correção | Defeito: OpcoesDoFlush.companyId; a rota passa o companyId do token; o SELECT, o vencimento do conteúdo protegido e a faxina do cofre seguem o escopo; o worker continua global. Flushes de escopos diferentes andam em fila (nunca em paralelo), o mesmo escopo compartilha a promessa em voo (o teste de sobreposição existente segue verde). Decisão do dono: tabela core_email_identidade (DDL canônica, CORE_TABLES_IN_DELETE_ORDER), IdentidadeDoRemetente.ts e GET/PUT /core/emails/identidade (gerente_loja/gerente_oficina, empresa do token, auditoria email.identidade.update): modo grupo = padrão seguro, o comportamento de antes; modo empresa = nome no De: (com o endereço do ambiente, que funciona em qualquer provedor), Reply-To da loja, assinatura no corpo (montada no instante do fato) e endereço próprio opcional com aviso de que o provedor precisa permitir. Validação contra injeção de cabeçalho (controle, aspas, <, >, barra invertida). O carteiro monta From/Reply-To por empresa a cada flush. Tela: cartão "Quem assina os e-mails desta empresa" com a prévia do servidor; nota de que Processar fila entrega só esta empresa. |
| DEPOIS | O defeito foi corrigido: o flush manual usa o companyId do token, e o worker continua global. Escopos diferentes rodam em fila, nunca em paralelo. As duas opções da decisão já existem: modo 'grupo' (padrão, comportamento antigo) e modo 'empresa' (nome no De:, Reply-To, assinatura e endereço próprio opcional). A escolha é por tela e auditada, com validação contra injeção de cabeçalho. |
| Arquivos | server/src/services/notifications/EmailService.ts, server/src/services/notifications/IdentidadeDoRemetente.ts, server/src/db/schema.ts, server/src/routes/v1/core.ts, server/tests/remetente-por-empresa.test.ts, server/tests/contador-varredura-das-rotas.test.ts, src/components/gs/RemetenteDaEmpresa.tsx, src/pages/gs/EmailsPage.tsx, src/pages/gs/__tests__/EmailsPage.test.tsx, docs/audits/remediacao/migracoes/EML.md |
| COMMIT | d25407b, f899ec1 |
| TESTES | server/tests/remetente-por-empresa.test.ts:122-151: o gerente de A envia 1 mensagem, a de B continua 'pending', e o worker a entrega depois. Clique e worker simultâneos entregam cada mensagem uma vez. Outros casos: modo empresa com From/Reply-To/assinatura só na Gringa, auditado. Recusas 400/403. Voltar ao grupo. EmailsPage.test.tsx: remetente padrão e PUT. Rodei: verdes. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:14235-14248 (flushEmailQueue({companyId})), :14254-14287 (GET/PUT identidade, empresa do token); server/src/services/notifications/EmailService.ts:1655-1668 (escopo e fila de flushes), :1857 (filtro por empresa), :1875-1903 (From/Reply-To por empresa); server/src/services/notifications/IdentidadeDoRemetente.ts:147-195 (validação), :204-235 (gravação), :272-295 (assinatura e cabeçalhos); src/pages/gs/EmailsPage.tsx:249 (RemetenteDaEmpresa). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **OWNER_DECISION_REQUIRED** — Decisão do dono |
| Insumo externo | Emanuel decide, empresa por empresa, na tela E-mails: remetente do grupo (padrão, já vale) ou da empresa. Endereço próprio só funciona se estiver cadastrado como 'Enviar como' no provedor SMTP. |

### GAP-PRD-199 — Templates de conta e contador aparecem como slug cru na tela da fila

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas / EML |
| ANTES | O ROTULO da EmailsPage cobria 4 modelos, e recuperacao_senha, conta_criada e outros apareciam como código cru. |
| Causa | O vocabulário dos modelos morava numa cópia na tela, desatualizada desde o primeiro modelo novo. |
| Correção | EMAIL_TEMPLATES (lista) e EMAIL_TEMPLATE_LABEL: Record<EmailTemplate,string> no EmailService — modelo novo sem rótulo não compila; rotuloDoModelo devolve o código para linha antiga desconhecida. listEmailQueue e a rota de avisos da OS entregam templateLabel; EmailsPage usa o rótulo do servidor e o mapa local saiu. |
| DEPOIS | EMAIL_TEMPLATE_LABEL é um Record<EmailTemplate,string>, então modelo sem rótulo não compila. Os 20 modelos têm rótulo em português. A rota entrega templateLabel, e a tela usa o rótulo do servidor. |
| Arquivos | server/src/services/notifications/EmailService.ts, server/tests/rotulos-e-promessas-do-email.test.ts, src/pages/gs/EmailsPage.tsx, src/pages/gs/__tests__/EmailsPage.test.tsx |
| COMMIT | d25407b, f899ec1 |
| TESTES | server/tests/rotulos-e-promessas-do-email.test.ts:71-104: todo modelo tem rótulo sem '_', e GET /core/emails entrega 'Recuperação de senha'. EmailsPage.test.tsx: 'o rótulo vem do servidor'. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/notifications/EmailService.ts:76-129 (lista, rótulos e rotuloDoModelo), :1373-1391 (paraATela entrega templateLabel); server/src/services/notifications/AvisosDaOficina.ts:337; src/pages/gs/EmailsPage.tsx:285. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-200 — Portal promete 'enviamos um link' e código de verificação mesmo com o carteiro desligado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | Todas (hoje EMAIL_ENABLED=false no .env do dono) / EML |
| ANTES | O portal dizia 'enviamos um link' e 'Código novo enviado' mesmo com EMAIL_ENABLED=false. |
| Causa | A resposta anti-enumeração foi escrita supondo o carteiro ligado; nada consultava carteiroConfigurado(). |
| Correção | PromessaDoEnvio.ts: promessaDaRecuperacao/promessaDoCodigo/situacaoDoEnvio dependem só de carteiroConfigurado() (lido ao vivo) — a mesma resposta com e sem conta. recuperar-senha e reenviar-verificacao devolvem envioDeEmailAtivo + message; GET /loja/portal/envio-de-email (rotaPublica, sem detalhe de configuração). MinhaContaPage mostra a frase do servidor e pergunta antes de prometer (só no modo recuperar e no aviso de confirmação — a tela de entrar continua sem chamada). Caminho manual que existe: o código de convite do balcão (resgate em Minha conta › Meus equipamentos), que liga o cadastro à conta sem o código por e-mail; a mensagem aponta para ele. |
| DEPOIS | A frase depende de carteiroConfigurado(), lido ao vivo. É a mesma com e sem conta, então não revela quem tem conta. Com o envio desligado, diz 'ainda está sendo ativado' e aponta o código de convite do balcão. GET /loja/portal/envio-de-email é pública, sem detalhe de configuração, e a tela pergunta antes de prometer. |
| Arquivos | server/src/services/notifications/PromessaDoEnvio.ts, server/src/routes/v1/storefront.ts, server/tests/rotulos-e-promessas-do-email.test.ts, src/pages/gs/MinhaContaPage.tsx, src/pages/gs/__tests__/MinhaContaPage.test.tsx |
| COMMIT | d25407b, f899ec1 |
| TESTES | server/tests/rotulos-e-promessas-do-email.test.ts:114-174: com o envio desligado, a mensagem não contém 'enviamos' e o corpo é idêntico com e sem conta. Ligado, volta 'enviamos um link', também idêntico. O código aponta o convite. A rota pública não expõe EMAIL_/SMTP. MinhaContaPage.test.tsx:601-648: a tela avisa antes e não mostra 'Código novo enviado'. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/notifications/PromessaDoEnvio.ts:39-74; server/src/routes/v1/storefront.ts:974-982 (reenviar-verificacao), :1508-1514 (envio-de-email), :1520-1530 (recuperar-senha); src/pages/gs/MinhaContaPage.tsx:78-80, :155, :707, :756. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |
| Insumo externo | Ligar o SMTP (GAP-PRD-130, M3) faz o portal voltar a prometer o envio — sem mudar código. |

### GAP-PRD-201 — Regra 'e-mail nunca derruba o fato' só é blindada no caminho do pedido; nos avisos de conta o enfileiramento não tem try/catch

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | Todas / EML |
| ANTES | Só enfileirarEmailDoPedido protegia o enfileiramento com try/catch. Nos avisos de conta, uma falha no INSERT desfazia o registro ou a troca de senha. |
| Causa | O contrato "a notificação nunca derruba o fato" era aplicado por convenção só em enfileirarEmailDoPedido. |
| Correção | O contrato mora na fila: semDerrubarOFato roda o enfileiramento num SAVEPOINT próprio (withTransaction aninhado), a falha desfaz só ele, vira logError(email_nao_enfileirado) sem segredo e devolve null; vale para queueEmail, queuePasswordResetEmail, queueVerificacaoEmail, queueContaCriadaEmail e queueSenhaAlteradaEmail (e para falha do cofre ao selar, sem cair para texto claro). queuePacoteContadorEmail continua lançando de propósito (ali o e-mail é o fato). Nenhum chamador do portal precisou mudar. |
| DEPOIS | O contrato fica dentro da fila: semDerrubarOFato roda o INSERT num SAVEPOINT próprio, registra a falha em log e devolve null. Isso vale para queueEmail, reset, verificação, conta criada, senha alterada, Google ligado e mensagem pronta, e também para falha do cofre (o segredo nunca cai em claro). O pacote do contador continua lançando, de propósito. |
| Arquivos | server/src/services/notifications/EmailService.ts, server/tests/email-nunca-derruba-o-fato.test.ts |
| COMMIT | 6d929ce, 95d1de1 |
| TESTES | server/tests/email-nunca-derruba-o-fato.test.ts (8 casos): com a fila recusando INSERT, registro, convite, troca logada e redefinição pelo link continuam valendo. Pedir recuperação e código não estouram. FK de empresa inexistente devolve null. Falha dentro da transação do fato não desfaz o que veio antes. O pacote do contador ainda lança. Rodei: verde. |
| EVIDÊNCIA | server/src/services/notifications/EmailService.ts:848-862 (semDerrubarOFato), :914-922 (falha do cofre), :923 (segredo), :1101 (avisos da conta), :1244 (queueEmail), :1299 (queueMensagemPronta); server/src/db/sqlite.ts:118-125 (withTransaction aninhado usa SAVEPOINT). |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-202 — Senha provisória só é imposta pelo navegador: a API serve todas as rotas com a senha que a gestão conhece

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / SECURITY_RISK |
| Empresa / frente | As seis / SEG |
| ANTES | A senha provisória só era imposta no navegador. O token da provisória navegava a API inteira. |
| Causa | A bandeira must_change_password so atravessava o corpo do login; nenhum ponto do servidor a lia depois, e a imposicao ficava so no Protected do navegador. |
| Correção | issueSession recebe senhaProvisoria e grava a marca no JWT e na sessao de refresh (api_sessions, campo novo em colecao de documentos; ausente = false). O login marca quando senhaEProvisoria; refreshSession e switch-company carregam a marca. authMiddleware recusa token marcado com 403 API_PASSWORD_CHANGE_REQUIRED em toda rota, antes de requirePermission. As rotas da etapa (POST /auth/password, GET /auth/session, POST /auth/logout) usam autenticacaoDaEtapaDeTroca, nomeada na linha da rota. Tela: apiRequest, ao receber esse 403, marca a sessao guardada como provisoria, e o Protected passa a acompanhar a sessao (useSession) e manda para a etapa na hora. |
| DEPOIS | O login marca senhaProvisoria no JWT e em api_sessions. authMiddleware recusa o token marcado com 403 API_PASSWORD_CHANGE_REQUIRED, antes de requirePermission. Só POST /auth/password, GET /auth/session e POST /auth/logout aceitam, via autenticacaoDaEtapaDeTroca. O refresh e o switch-company carregam a marca. verifyAccessToken só é chamado no middleware. A tela marca a sessão e o Protected leva à etapa de troca. |
| Arquivos | server/src/middleware/auth.ts, server/src/services/api/ApiAuthService.ts, server/src/routes/v1/auth.ts, src/lib/api/client.ts, src/router/Protected.tsx, server/tests/senha-provisoria-no-servidor.test.ts, src/router/__tests__/senhaProvisoriaRecusadaPeloServidor.test.tsx, src/router/__tests__/environments.test.tsx, server/tests/empresa-nova-sem-codigo.test.ts |
| COMMIT | f16e460 |
| TESTES | server/tests/senha-provisoria-no-servidor.test.ts (8 casos): GET /core/products dá 403 API_PASSWORD_CHANGE_REQUIRED; a recusa vem antes da permissão; escrita e troca de operação também são recusadas; o refresh não lava a marca; sessão e logout respondem; depois da troca o login novo opera; o reset da gestão marca o próximo login. Tela: senhaProvisoriaRecusadaPeloServidor (3 casos). Rodei: verdes. |
| EVIDÊNCIA | server/src/middleware/auth.ts:51-105; server/src/routes/v1/auth.ts:197-205, :287, :807, :812, :827-845; server/src/services/api/ApiAuthService.ts:64, :78, :196; src/lib/api/client.ts:662; src/router/Protected.tsx:59. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-203 — Impressora só na Preço Justo (navegador), terminal 'mock' cadastrado na PJ, TEF e impressão silenciosa dependem de hardware/agente

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / EXTERNAL_HARDWARE_REQUIRED |
| Empresa / frente | As seis (Gringa, Me Mimei, Conceito, PJ Motors, Oficina sem impressora cadastrada) / PAG |
| ANTES | Só a Preço Justo tinha impressora (pelo navegador). A configuração de maquininha mock está ligada na Preço Justo. TEF e impressão silenciosa dependem de hardware. |
| Causa | Periferico e contrato de cada operacao sao insumo do dono; faltava a prontidao dizer, por operacao, o que falta. |
| Correção | pendenciasDeConfiguracao: operacao sem impressora de cupom (quem: equipamento; onde: Configuracoes > Impressoras) e impressora de agente sem agente no ar ou sem pagina de teste confirmada; a maquininha mock ligada continua como bloqueio critico (P1). Docs: GO_LIVE_CHECKLIST (impressora de cupom por balcao com teste; nenhuma maquininha de teste ligada), ESTADO-ATUAL (impressao silenciosa e gaveta), OPERATIONS (instalar o agente de impressao), migracoes/PAG.md P6 (dado medido, sem SQL). |
| DEPOIS | Cada periférico tem caminho por tela: impressora por operação em Configurações > Impressoras; desligar a mock em Vendas > Conferência de maquininha (POST /pdv/terminal/configurations/:id/deactivate); agente local de impressão (GAP-PRD-082). A prontidão aponta a operação sem impressora de cupom e a impressora de agente sem teste confirmado, e trata a mock ligada como bloqueio crítico. |
| Arquivos | server/src/services/system-admin/CoreProductionReadinessService.ts, server/tests/prontidao-das-operacoes.test.ts, docs/GO_LIVE_CHECKLIST.md, docs/ESTADO-ATUAL.md, docs/OPERATIONS.md, docs/audits/remediacao/migracoes/PAG.md |
| COMMIT | d6269dd, 38f97c4 |
| TESTES | server/tests/prontidao-das-operacoes.test.ts: sem impressora aparece a pendência de equipamento; impressora de agente sem agente no ar também. server/tests/impressao-pelo-agente-local.test.ts e agente-local-impressora.test.ts cobrem o caminho do periférico. Rodei: verdes. Não rodei maquininha-de-teste-fora-da-producao neste lote (a suíte inteira está verde em 1078ddb). |
| EVIDÊNCIA | server/src/services/system-admin/CoreProductionReadinessService.ts:132-162 (impressora e agente por operação), :77-84 e :195-202 (mock é bloqueio crítico); routes/v1/core.ts:4849-4855 (desligar configuração); src/router/gsRoutes.tsx:332 (impressoras); docs/GO_LIVE_CHECKLIST.md:86,94. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **EXTERNAL_HARDWARE_REQUIRED** — Equipamento externo |
| Insumo externo | Uma impressora de cupom por balcão nas seis operações, cadastrada em Configurações > Impressoras (térmica com agente local para cupom sem diálogo e gaveta por comando). Desligar a maquininha de teste (mock) da Preço Justo em Vendas > Conferência de maquininha. PinPad e cliente TEF homologados por caixa quando houver contrato: esse caminho depende do GAP-PRD-014, fora deste lote, e não o verifiquei a fundo aqui. |

### GAP-PRD-204 — XML de nota manual: 404 com mensagem que engana ('entrou antes de o sistema passar a guardar o arquivo')

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | As seis / EST |
| ANTES | GET /purchases/notes/:id/xml de uma nota manual recém-criada respondia 404 CORE_INBOUND_NOTE_XML_AUSENTE, dizendo que ela 'entrou antes de o sistema passar a guardar o arquivo'. |
| Causa | a rota do XML so distinguia nota inexistente de xml_original nulo, sem olhar doc_type |
| Correção | getNoteXml devolve docType; GET /purchases/notes/:id/xml responde 404 CORE_INBOUND_NOTE_MANUAL_SEM_XML 'lancada manualmente, sem nota fiscal... conta em Compras sem NF-e' para doc_type manual; nota de XML antiga mantem CORE_INBOUND_NOTE_XML_AUSENTE |
| DEPOIS | Para doc_type manual sem XML a resposta é 404 CORE_INBOUND_NOTE_MANUAL_SEM_XML, dizendo 'lançada manualmente, sem nota fiscal… Compras sem NF-e'. A nota de XML antiga continua com o código e a frase dela. |
| Arquivos | server/src/services/core/NfeImportService.ts, server/src/routes/v1/core.ts, server/tests/entrada-casamento-com-o-catalogo.test.ts, src/pages/gs/__tests__/EntradaNotasXml.test.tsx |
| COMMIT | 50b6646 |
| TESTES | server/tests/entrada-casamento-com-o-catalogo.test.ts:498-535 (a nota criada por POST /purchases/manual tem código próprio, a frase 'lançada manualmente' e não a frase antiga; a nota antiga mantém a frase dela). src/pages/gs/__tests__/EntradaNotasXml.test.tsx:190 (entrada manual sem botão). Rodado: verde. |
| EVIDÊNCIA | server/src/routes/v1/core.ts:12579-12594; server/src/services/core/NfeImportService.ts:2505-2510 (getNoteXml devolve docType) |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-205 — Perfil da conta com mais de um cadastro vinculado mostra o nome de um deles de forma arbitrária

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | preco-justo, gringa, me-mimei, conceito, pj-motors / ECO |
| ANTES | Uma conta com dois cadastros vinculados mostrava o nome de um deles de forma arbitrária, pela ordem das linhas. |
| Causa | getProfile lia "o primeiro" cadastro vinculado; a conta nao tinha nome proprio. |
| Correção | O nome e o da conta; conta antiga sem nome proprio usa o cadastro vinculado mais recentemente (l.created_at DESC, c.updated_at DESC) e devolve nameSource (conta\|cadastro); a tela avisa quando o nome veio do cadastro. |
| DEPOIS | O nome é o da conta. A conta antiga sem nome próprio usa o vínculo mais recente (l.created_at DESC, c.updated_at DESC) e devolve nameSource 'cadastro'. A tela avisa quando o nome veio do cadastro. |
| Arquivos | server/src/services/core/CustomerAccountService.ts, src/components/gs/ContaDoCliente.tsx, server/tests/perfil-mora-na-conta.test.ts, src/components/gs/__tests__/perfilDaConta.test.tsx |
| COMMIT | 4313dbe |
| TESTES | server/tests/perfil-mora-na-conta.test.ts:180-211: sem nome próprio, fala o cadastro vinculado mais recentemente (nameSource 'cadastro'); com nome próprio, fala a conta e o nome salvo chega aos dois cadastros. Tela: perfilDaConta.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CustomerAccountService.ts:558-592 (ORDER BY l.created_at DESC, c.updated_at DESC, c.id; nameSource); src/components/gs/ContaDoCliente.tsx:259-263. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-206 — Tela de login sonda GET /auth/quick-login/users mesmo com o quick-login desligado — 404 no console em produção

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / UX_OPERATIONAL_RISK |
| Empresa / frente | todas / SEG |
| ANTES | A tela de login sondava GET /auth/quick-login/users a cada abertura, gerando 404 em produção. |
| Causa | A tela descobria o atalho de desenvolvimento pelo 404 da rota, em toda abertura e em toda instalacao. |
| Correção | listQuickLoginUsers so toca a rede com VITE_DEV_QUICK_LOGIN=true (valor exato) no build; sem ela devolve a lista vazia. .env.example e .env.production.example documentam a flag (false por padrao). |
| DEPOIS | listQuickLoginUsers devolve [] sem tocar a rede, a menos que o build tenha VITE_DEV_QUICK_LOGIN com o valor exato 'true'. É o único chamador da rota na tela. A flag está documentada como false nos três .env de exemplo. |
| Arquivos | src/lib/api/client.ts, src/pages/gs/LoginPage.tsx, .env.example, .env.production.example, src/lib/api/__tests__/sondaDoAtalhoSoComFlag.test.ts |
| COMMIT | 1b4ba0d |
| TESTES | src/lib/api/__tests__/sondaDoAtalhoSoComFlag.test.ts (6 casos): com a flag ausente, 'false', 'TRUE ' ou 'sim', a lista é vazia e nenhuma requisição sai; com 'true', pergunta ao servidor; um 404 vira lista vazia. Rodei: verde. |
| EVIDÊNCIA | src/lib/api/client.ts:891-893, :910-911; src/pages/gs/LoginPage.tsx:160-163; .env.example:21; .env.staging.example:10; .env.production.example:108. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-207 — Produto publicado sem foto aparece na vitrine ('FOTO EM BREVE') embora a régua de prontidão o marque como bloqueado

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | preco-justo, gringa, me-mimei, conceito, pj-motors / ECO |
| ANTES | Produto publicado sem foto aparecia na vitrine, mas a prontidão online o marcava como bloqueado (sem_foto) — duas verdades. |
| Causa | Duas réguas: listOnlineReadiness tratava a foto como impedimento, enquanto o PUT e a vitrine a tratam como opcional — a vitrine tem o marcador 'Foto em breve' de propósito e a foto só pode subir depois que o produto existe (o cadastro publica antes). |
| Correção | Reclassificação (a segunda correção da ficha): OnlineWarning 'sem_foto' em warnings; OnlineBlocker perde sem_foto; ready e readyToPublish não contam aviso. publishReadyProducts(companyId,{incluirSemFoto}) só leva os sem foto quando pedido e devolve semFoto (quantos esperam a decisão); POST /core/products/publicar-prontos lê incluirSemFoto===true e grava na trilha product.publish_ready {published, skipped, semFoto, incluirSemFoto}. Telas: ProntidaoOnlinePage mostra 'Sem foto (aviso)' ao lado dos impedimentos, conta o publicado sem foto como Vendendo, o botão principal publica só os completos e 'Publicar também N sem foto' manda incluirSemFoto:true; FotosEmLotePage e LojaAdminPage leem warnings (e o formato antigo); ProdutoFormPage avisa que sem foto publica como 'Foto em breve'. |
| DEPOIS | Aplicada a segunda correção da ficha: sem_foto virou aviso (warnings) e ready/readyToPublish não contam aviso. A publicação em massa só leva os sem foto com incluirSemFoto:true, conta os que ficaram e registra a escolha na trilha. As telas mostram 'Sem foto (aviso)' e o ProdutoFormPage avisa 'Foto em breve'. |
| Arquivos | server/src/services/core/CatalogService.ts, server/src/routes/v1/core.ts, server/tests/publicar-sem-foto-uma-regua.test.ts, server/tests/prontidao-online.test.ts, src/pages/gs/ProntidaoOnlinePage.tsx, src/pages/gs/FotosEmLotePage.tsx, src/pages/gs/LojaAdminPage.tsx, src/pages/gs/ProdutoFormPage.tsx, src/pages/gs/__tests__/prontidaoSemFotoEAviso.test.tsx |
| COMMIT | 3cc838d |
| TESTES | server/tests/publicar-sem-foto-uma-regua.test.ts (5): publicado sem foto aparece na vitrine com imageUrl null e a prontidão diz ready com warnings ['sem_foto']; com foto, sem aviso; não publicado sem foto = readyToPublish com o aviso; o lote sem pedido publica só os completos e conta semFoto 1; com incluirSemFoto publica e a trilha registra. Também prontidao-online.test.ts. Tela: prontidaoSemFotoEAviso.test.tsx. Rodei: verdes. |
| EVIDÊNCIA | server/src/services/core/CatalogService.ts:1932-1956 (tipos), 2010-2012 (aviso), 2038-2039 (ready), 2056-2077 (publishReadyProducts); server/src/routes/v1/core.ts:1138-1150 (incluirSemFoto na trilha); src/pages/gs/ProntidaoOnlinePage.tsx:84, 111-120, 164; src/pages/gs/ProdutoFormPage.tsx:2095-2099. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-208 — KPI 'EM ABERTO' de Contas a receber mostra como subtítulo a contagem TOTAL de lançamentos, não a dos abertos

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / BUG |
| Empresa / frente | todas / FIN |
| ANTES | O KPI 'Em aberto' mostrava R$ 0,00 com o subtítulo '1 lançamento(s)', que vinha de summary.count (todos, quitados inclusive). |
| Causa | A contagem ao lado do valor em aberto contava outra coisa. |
| Correção | summarize devolve openCount e overdueCount; o KPI mostra N em aberto; servidor antigo sem openCount conta os abertos da propria lista. |
| DEPOIS | summarize devolve openCount (settled_cents < amount_cents) e overdueCount. O KPI mostra 'N em aberto' a partir de openCount. Com servidor antigo, sem openCount, a tela conta os abertos da própria lista. |
| Arquivos | server/src/services/core/FinanceService.ts, src/lib/api/core.ts, src/pages/gs/ContasPage.tsx, server/tests/saldo-da-conta-segue-o-carimbo.test.ts, server/tests/audit-finance.test.ts, src/pages/gs/__tests__/contasKpiEmAberto.test.tsx |
| COMMIT | 17f6525 |
| TESTES | server/tests/saldo-da-conta-segue-o-carimbo.test.ts, bloco GAP-PRD-208 com 2 casos. Afirma: openCount conta só quem deve e count segue o total; com o único lançamento liquidado, 'em aberto' conta zero. src/pages/gs/__tests__/contasKpiEmAberto.test.tsx cobre a tela. Rodei os dois: verdes. |
| EVIDÊNCIA | server/src/services/core/FinanceService.ts:413-415 e :432-447; src/pages/gs/ContasPage.tsx:436-439 e :482-486. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-209 — Replay de POST /workshop/orders/:id/checkout com a mesma Idempotency-Key devolve 409 em vez de repetir a resposta original

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / INCONSISTENT_CONTRACT |
| Empresa / frente | oficina / OFI |
| ANTES | Reenviar o checkout da OS com a mesma Idempotency-Key devolvia 409 CORE_ORDER_NOT_AWAITING_PAYMENT, e quem perdeu a resposta não recebia o resultado. |
| Causa | a checagem de status vinha antes da busca por chave; e a chave descia crua para createSale (sem namespace do documento) |
| Correção | receberOs procura primeiro a venda pela chave com namespace da OS (os:<id>:<Idempotency-Key>, ou os-<id>[:n apos estorno] sem cabecalho) e pela chave crua da venda da OS finalizada (legado); achou: 200 com a mesma venda, order e replay:true, sem auditoria nova; venda cancelada por estorno: 409 CORE_CHECKOUT_REVERSED; a tela usa uma chave por dialogo e a reusa em toda nova tentativa (queda de rede, liberacao do gestor) |
| DEPOIS | receberOs procura a venda pela chave com namespace da OS (e pela chave crua do legado) antes de conferir o status. Se acha, devolve 200 com a mesma venda, a order e replay:true, sem auditoria nova. Venda estornada dá 409 CORE_CHECKOUT_REVERSED. A tela usa uma chave por diálogo e a reusa nas novas tentativas. |
| Arquivos | server/src/services/core/WorkshopCashierService.ts, server/src/routes/v1/core.ts, src/components/gs/RecebimentoOsDialog.tsx, server/tests/caixa-da-oficina.test.ts, server/tests/workshops-equipment.test.ts, src/pages/gs/__tests__/caixaDaOficina.test.tsx |
| COMMIT | 411f040 |
| TESTES | server/tests/caixa-da-oficina.test.ts:482-520: a mesma chave dá 200, replay:true, a mesma venda, uma venda e um título; sem cabeçalho também repete; outra chave em OS paga continua 409. Rodei: verde. caixaDaOficina.test.tsx: verde. |
| EVIDÊNCIA | server/src/services/core/WorkshopCashierService.ts:109-116, :198-220; server/src/routes/v1/core.ts:10094-10148; src/components/gs/RecebimentoOsDialog.tsx:75, :152. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

### GAP-PRD-210 — O build de produção do frontend gera source maps (5 MB) e um único bundle de 1,36 MB

| Campo | Valor |
| --- | --- |
| Severidade / categoria iniciais | P3 / DEPLOYMENT_RISK |
| Empresa / frente | todas / INT |
| ANTES | vite.config.ts tinha sourcemap: true (5 MB de .map publicados) e gerava um bundle único de 1,36 MB. |
| Causa | (a) A recusa do mapa lia so o ultimo pedaco do caminho, mas a barra final e o . somem na normalizacao que o express.static e o Windows fazem. (b) A poda do service worker desacoplava a casca guardada dos pedacos que ela cita. |
| Correção | Da frente: ver a linha anterior deste id. Da verificacao: (a) ehMapaDeFonte recusa se QUALQUER pedaco do caminho, lido como o disco o le (sem :fluxo, sem ponto e espaco no fim), termina em .map. (b) guardarAsTelas so troca de lado quando todos os pedacos novos entraram: guarda a casca nova (/ e /index.html, as duas da rede antes de trocar), so entao poda e marca a versao; pedaco que falha nao troca nada; a instalacao nao rebusca a casca; navegacao de tela (sem extensao) sem rede usa a casca atual antes da copia por endereco. (c) Caddyfile.example modo B (Windows) passa de path *.map para path_regexp (?i).map([.s:/\]\|$); DEPLOY.md lista as grafias novas e corrige o maior pedaco para 400,50 kB. |
| DEPOIS | sourcemap vem de mapaDeFonteDoBuild: o padrão é false, 'hidden' gera sem o comentário, e qualquer outro valor recusa o build. As telas carregam sob demanda (95 import() em src/router/telas.tsx). A API recusa servir .map em qualquer grafia, e o service worker não poda pacote que a casca guardada cita. |
| Arquivos | server/src/services/implantacao/frontendEstatico.ts, server/tests/a-api-nao-entrega-mapa-de-fonte.test.ts, public/sw.js, src/lib/__tests__/service-worker-guarda-as-telas.test.ts, deploy/caddy/Caddyfile.example, docs/DEPLOY.md, src/lib/build/configuracaoDoBuild.ts, src/lib/build/__tests__/configuracaoDoBuild.test.ts, vite.config.ts |
| COMMIT | c3a4afa, 44e43c2, 0b437e7, 15e86cb, 5a739b6 |
| TESTES | a-api-nao-entrega-mapa-de-fonte (servidor), configuracaoDoBuild.test.ts e service-worker-guarda-as-telas.test.ts (tela): rodados, verdes. Não rodei vite build; uso o fato já medido (build sem .map). |
| EVIDÊNCIA | vite.config.ts:135; src/lib/build/configuracaoDoBuild.ts:43-59; src/router/telas.tsx (95 import()), src/router/telaSobDemanda.ts (lazy); server/src/services/implantacao/frontendEstatico.ts:64-70, :144-148. |
| Veredito independente | CONFIRMADO |
| STATUS FINAL | **RESOLVED_PROVEN** — Resolvido e provado |

## Apêndice — commits da remediação

`git log dc48841..99d01b3`, do mais novo ao mais antigo.

- `99d01b3e` docs(remediacao): o gaps.json consolida o journal depois da reauditoria final - 174 RESOLVED_PROVEN, 2 RESOLVED_BY_ROOT_CAUSE, 19 EXTERNAL_CONFIGURATION_REQUIRED, 3 EXTERNAL_HARDWARE_REQUIRED, 12 OWNER_DECISION_REQUIRED, nenhuma aberta
- `a250a117` merge(remediacao): integra a rodada 3 da verificacao final - o municipio do IBGE conferido antes de numerar e no emitente (GAP-PRD-028) (branch int/r3-ibge)
- `4878ad26` merge(remediacao): integra a rodada 3 da verificacao final - NF-e de homologacao fora da producao e o cursor DF-e pelo ultNSU da SEFAZ (GAP-PRD-168) (branch int/r3-dfe)
- `2c1e3aff` docs(remediacao): o journal INT registra a verificacao adversarial do R3-IBGE (GAP-PRD-028)
- `43c7013c` docs(remediacao): o journal INT registra a verificação adversarial do R3-DFE (GAP-PRD-168)
- `a0b0be73` fix(r3-ibge): a nota aponta a cidade escrita que desmente o codigo, o emitente com a UF no fim passa, e a UF errada da 84 se corrige (GAP-PRD-028)
- `e0c03572` fix(r3-dfe): uma consulta da Distribuição por vez, e dois cliques juntos não repetem o ultNSU (GAP-PRD-168)
- `ee973ccf` docs(remediacao): o journal INT registra o R3-DFE do GAP-PRD-168 — tpAmb na importacao e cursor pelo ultNSU
- `acd5dc9b` docs(remediacao): o journal INT registra a R3-IBGE (GAP-PRD-028), e o go-live confere o municipio do emitente
- `ebf4940e` feat(pedidos): a ficha do pedido corrige o municipio da nota ali mesmo (GAP-PRD-028)
- `81134b3c` fix(fiscal): a nota confere o municipio na tabela do IBGE antes de numerar, e o emitente tambem (GAP-PRD-028)
- `67cceb6f` fix(dfe): o cursor da Distribuição é o ultNSU que a SEFAZ devolve, e a espera dela é respeitada (GAP-PRD-168, R3-DFE)
- `8328b7fd` fix(nfe-import): nota de homologação não entra numa empresa em produção (GAP-PRD-168, R3-DFE)
- `bfb7c04e` merge(remediacao): integra a rodada 2 da sessao - a troca exige a prova, as abas dividem a sessao e o logout chega pelo refresh (branch int/r2-sessao)
- `1b4c025e` merge(remediacao): integra a rodada 2 da idempotencia - chaves do servidor reservadas, telas depois do 422 e o checkout do carrinho inteiro (branch int/r2-idem)
- `35183db5` fix(r2-sessao): sem Web Locks, a aba que perde a rotacao espera a vizinha em vez de cair
- `07dda2f4` merge(remediacao): integra a verificacao final do GAP-PRD-028 - o codigo IBGE sai do nome da cidade (branch int/res-ibge)
- `f239ecd6` merge(remediacao): integra a verificacao final do GAP-PRD-168 - o NSU da Distribuicao DF-e por ambiente (branch int/res-dfe-amb)
- `d2aaf093` docs(remediacao): o journal INT registra a verificação adversarial do IBGE-MUNICIPIOS (GAP-PRD-028)
- `be9da650` fix(venda-offline): relancar como venda nova volta a recusar a MESMA venda da chave - a impressao de agora leva o dinheiro, como a gravada
- `c902e59f` fix(vendas-offline): a pendencia gravada antes da reserva nao sobe com a forma de uma chave do servidor
- `77c28f40` fix(sessao): a tranca entre abas desiste da espera e nao prende a renovacao de todas
- `b2a21626` fix(ibge-municipios): o endereço da nota também confere o código na tabela (GAP-PRD-028)
- `e6ea2842` fix(loja): o checkout recusado por outro carrinho pergunta antes de registrar pedido novo
- `41baa368` fix(telas): a tentativa que ja registrou outro lancamento e dita na lingua de quem opera, e a chave nova e escolha
- `b5532bb7` fix(sessao): duas abas dividem a sessao sem se derrubar, e o logout sai pelo refresh
- `847e4f60` docs(remediacao): a linha IBGE-MUNICIPIOS do GAP-PRD-028 guarda os arquivos de todas as linhas da ficha
- `7690daf7` fix(loja): o mesmo checkout e o mesmo carrinho inteiro, e a subida real leva as colunas sem passo
- `587eca98` fix(regularizar): vendaDaChave nula e resposta do servidor, e o relancamento sem gaveta fica provado
- `6d777c4b` fix(idem): a chave que o servidor deriva nao e do cliente, e a pendencia compara itens e dinheiro
- `23802345` docs(remediacao): o journal INT registra o residuo IBGE-MUNICIPIOS do GAP-PRD-028
- `9a557989` feat(loja+fiscal): o cliente escolhe a cidade e o codigo IBGE vem junto (GAP-PRD-028, IBGE-MUNICIPIOS)
- `b323e25c` feat(ibge): o codigo IBGE sai do nome da cidade — tabela oficial, comando do dono, busca publica e conferencia (GAP-PRD-028, IBGE-MUNICIPIOS)
- `d0a88cbb` fix(sessao): a troca de operacao exige a prova da sessao, e o logout chega pelo refresh
- `8bf6e681` fix(implantacao): so o que sai como tela troca a CSP - o 404 de arquivo, o mapa de fonte recusado e o POST num caminho de tela ficam com a da API
- `77d0bb72` fix(venda-offline): registrar como venda nova volta a recusar a MESMA mercadoria - a impressao de agora leva o dinheiro, como a gravada
- `b147aaee` docs(remediacao): o journal INT registra o NSU por ambiente da Distribuicao DF-e (GAP-PRD-168, DFE-AMBIENTE)
- `5c767385` merge(remediacao): integra os residuos do endurecimento pos-walkthrough (branch int/res-idem-viz)
- `51e46d9d` merge(remediacao): integra os residuos do endurecimento pos-walkthrough (branch int/res-idem-tela)
- `eb0f4fc5` merge(remediacao): integra os residuos do endurecimento pos-walkthrough (branch int/res-sessao)
- `085feac2` fix(res-idem-viz): o leitor de api_idempotency_keys volta a aparecer no inventario de um escritor por conceito
- `681ee7fb` feat(entrada-notas): a lista da SEFAZ diz quantos documentos do outro ambiente ficaram fora (GAP-PRD-168, DFE-AMBIENTE)
- `59e39fde` fix(dfe): o NSU da Distribuicao DF-e e por ambiente, e a producao nao herda o cursor da homologacao (GAP-PRD-168, DFE-AMBIENTE)
- `ecdfe755` fix(res-sessao): a venda guardada leva a operacao em que foi feita, e so sobe nela
- `25f4b09a` fix(res-idem-tela): com "Regularizar" aberto por cima do balcao, F8 nao finaliza o carrinho por baixo
- `8a0a752c` fix(res-idem-tela): o F8 por reflexo nao finaliza por baixo da pergunta da chave reusada
- `38ba0224` fix(res-idem-viz): o caixa da oficina volta a caber no limite de taxa do proprio teste
- `3cec7149` fix(res-sessao): a venda da fila nao vira recusada na outra operacao quando a sessao troca no meio do envio
- `ff0c7b9f` fix(sessao): o corpo do logout leva o refresh de agora, e o 401 nao repete em outra operacao
- `5efcde83` fix(sessao): sair encerra a familia inteira da sessao, e a troca e a rotacao nao deixam credencial viva
- `83a6749b` merge(remediacao): integra a correcao da reauditoria do GAP-PRD-168 (branch int/hard-168)
- `7b8e41d9` merge(remediacao): integra a correcao da reauditoria do GAP-PRD-028 (branch int/hard-028)
- `33234ef6` fix(idempotencia): a mesma chave com outro corpo e recusada (422) nos vizinhos da venda, antes de escrever (RES-IDEM-VIZ)
- `ea167e57` fix(venda+oficina): o dinheiro entra na impressao da venda, e a mesma chave com outro pagamento e recusada (RES-IDEM-VIZ)
- `55d6f5d9` docs(remediacao): o journal INT registra a verificacao do GAP-PRD-168
- `fb00c67c` docs(journal): GAP-PRD-028 verificacao adversarial - a recusa do endereco vem antes da cotacao
- `a17826e6` fix(gap-prd-028): com conta, a recusa do endereco vem antes de cotar o frete
- `8e46c01d` fix(pdv+regularizar): a tentativa que ja registrou outra venda e dita na lingua do caixa, com a saida certa
- `71fc3e90` test(migracao): o banco da loja na versao 85 ganha a impressao digital da venda pela subida de verdade
- `9dcd8ea7` fix(venda-offline): a venda guardada cuja chave ja registrou outra venda relanca como venda nova
- `7eb354fd` fix(gap-prd-168): o ensaio antigo do simulador nao segura a SEFAZ de verdade
- `2c59d188` merge(remediacao): integra a recusa da mesma Idempotency-Key com outra mercadoria (branch int/hard-idem)
- `481cd242` merge(remediacao): integra o endurecimento do logout - o access token sai junto com o refresh (branch int/hard-sessao)
- `c2472d66` docs(remediacao): o journal INT registra o GAP-PRD-168 fechado pela reauditoria
- `1cd1a698` test(fiscal): a fabrica do slot real mede o ato sem nota, nao o slot aposentado (GAP-PRD-168)
- `087128e5` docs(journal): GAP-PRD-028 fecha a refutacao da reauditoria - com conta, entrega so em endereco salvo completo, com IBGE e destinatario
- `5f06f6a4` feat(compras): a Entrada de Notas mostra o caminho do certificado e pede a senha no dialogo da casa (GAP-PRD-168)
- `909562ff` fix(fiscal+compras): a consulta e a manifestacao DF-e passam pela politica dos atos (GAP-PRD-168)
- `d622b6dc` fix(venda): a mesma chave com outra mercadoria e recusada (422), e nao devolve a venda original calada
- `d8cef87b` fix(loja): a tela diz o que falta no endereco de entrega e deixa completar ali mesmo (GAP-PRD-028)
- `0ce14963` fix(loja): com conta, a entrega vai para o endereco salvo e completo - o servidor recusa o texto solto (GAP-PRD-028)
- `598c0cd8` fix(sessao): o logout encerra o token de acesso, nao so o refresh
- `80e85d36` docs(journal): a reauditoria final no journal - GAP-PRD-153 corrigido e provado, GAP-PRD-188 volta a OWNER_DECISION_REQUIRED (o dado da OS #1 so o dono decide pela tela)
- `615ca386` merge(remediacao): integra a correcao da reauditoria do GAP-PRD-153 (branch int/hard-153)
- `6310793e` fix(configuracao): a homologacao do Asaas manda configurar a variavel que vale, e nome aposentado nao volta ao produto (GAP-PRD-153)
- `1078ddbb` test(oficina): o teste do token opaco le o token do banco - ele nao sai mais na resposta de criacao (GAP-PRD-106)
- `933d838d` docs(remediacao): o gaps.json consolida o journal - as 210 fichas com status final, commits e provas
- `d2dee609` fix(integracao): o teste do pos-venda do portal da CEP ao emitente (GAP-PRD-097 x GAP-PRD-125)
- `3c9a543e` merge(remediacao): integra o grupo LEG (GAP-PRD-075, branch int/leg)
- `cdd510c4` docs(journal): verificacao do lote LEG — GAP-PRD-075 se sustenta depois de 95b0e73 (/system/audit sai do ar)
- `95b0e732` fix(LEG): GET /system/audit sai do ar — a segunda trilha de auditoria inventava a linha "stub scan" (GAP-PRD-075)
- `d9e991ea` docs(journal): GAP-PRD-075 fecha — um escritor por conceito, com a lista final escritor -> leitor (lote LEG)
- `19632aa4` fix(legado): o que a suite inteira achou depois da juncao — duas variaveis sem leitor, dois atalhos para arquivo apagado e uma prova sobre colecao aposentada (GAP-PRD-075)
- `07f1eede` feat(maquininha+legado): o pedido de estorno aparece na cobranca, a conciliacao vazia sai, e o inventario de um escritor por conceito vira teste (GAP-PRD-075)
- `5d963aa4` fix(asaas+legado): o aviso, o vinculo e a trilha do Asaas tem uma verdade so, e o passo 85 leva as linhas antigas para ela (GAP-PRD-075)
- `e5de764f` docs(remediacao): journal da integracao - os consertos depois das verificacoes (GAP-PRD-106, 140, 210, 061)
- `73dcd050` fix(oficina): a resposta de criar equipamento deixa de trazer o token do QR (GAP-PRD-106)
- `4de4ad7a` fix(fiscal+legado): o CSC vai ao nucleo, e o segundo escritor de documento fiscal sai com as doze colecoes dele (GAP-PRD-075)
- `4a7da58f` fix(empresas): o endereco de loja de uma empresa nova nunca e rota do sistema (/pdv, /login, /loja, /sistema)
- `7b9b205d` fix(telas): /sistema abre o painel, e nao "Esta loja nao existe"
- `5a739b69` fix(build): o build recusa endereco da API que e caminho do disco - o "/" que o Git Bash reescreve (GAP-PRD-061, GAP-PRD-210)
- `905e2a11` fix(legado): /integrations e o relatorio de staging saem do ar — a segunda porta de cada credencial, sem tela (GAP-PRD-075)
- `48142a2c` fix(esquema): o aviso da subida sem ponto dobrado, e o indice unico recusado diz onde corrigir (GAP-PRD-140)
- `0a68461d` docs(remediacao): journal da integracao - a CSP das telas servidas pela API (GAP-PRD-156, GAP-PRD-061)
- `a6ba71a0` merge(remediacao): integra o grupo ESQ (GAP-PRD-140, GAP-PRD-142, branch int/esq)
- `d5b8e616` fix(integracao): a tela servida pela API deixa de herdar a CSP da API - sem isso ela abria em branco (GAP-PRD-156, GAP-PRD-061)
- `33241ec4` docs(ESQ): a verificacao confirma GAP-PRD-140 e GAP-PRD-142 no clone do banco real
- `00cc0072` merge(remediacao): integra o grupo BUILD (GAP-PRD-210, branch int/build)
- `5d5375b5` docs(remediacao): journal da verificacao BUILD - GAP-PRD-210 refutado em dois pontos, corrigido e fechado
- `15e86cb6` fix(BUILD): o exemplo do Caddy recusa o .map em toda grafia do Windows, e o DEPLOY diz o numero medido (GAP-PRD-210)
- `44f3ca71` test(integracao): o desligamento com prazo espera a requisicao presa chegar, e nao 50 ms (GAP-PRD-063)
- `0b437e7c` fix(BUILD): o mapa nao sai por barra no fim, e a casca guardada nunca cita pacote podado (GAP-PRD-210)
- `f1a5da31` fix(integracao): a entrada manual vence no dia da loja, e nao no de Greenwich
- `660830b3` merge(integracao): junta a integracao (ECO e consertos) a frente FIS
- `b3db7422` fix(integracao): a imagem Docker leva os XSD fiscais para o lado do server/dist
- `114561d9` fix(integracao): o roteador da NFS-e passa pela regra de alcance e pela varredura do contador
- `dccc17b9` merge(remediacao): integra a frente FIS (branch rem/fis)
- `6bac6882` docs(remediacao): o SQL e a prova em clone do grupo ESQ, e o journal fecha GAP-PRD-140 e GAP-PRD-142
- `775c535c` fix(financeiro): a competencia legada vai para o dia da loja, e as migracoes antigas param de cortar por Greenwich (GAP-PRD-142)
- `1e0a7931` feat(esquema): o banco migrado confere com um banco novo, e a subida repara indice, DEFAULT e UNIQUE antigos (GAP-PRD-140)
- `1c0c8f84` docs(remediacao): journal da integracao BUILD - GAP-PRD-210 fechado
- `db0ae4a0` fix(integracao): os fontes voltam a ser texto - o byte NUL cru sai do StorefrontService, e uma trava varre o repositorio (GAP-PRD-047, GAP-PRD-095)
- `44e43c26` feat(build): sem mapa de fonte publico, uma tela por pedaco e o service worker guardando todas (GAP-PRD-210)
- `7777b5f9` test(promocoes): a vigencia so se mede numa promocao que existe (GAP-PRD-032)
- `c3a4afa8` fix(implantacao): a API recusa entregar mapa de fonte, em toda grafia que o disco leria (GAP-PRD-210)
- `f0bc5f75` docs(remediacao): journal da integracao - GAP-PRD-158 e 159 fechados, e o nome da URL publica corrigido em GAP-PRD-002 e 017
- `c85d4906` fix(telas): as telas da loja online perguntam pela tela e prendem o foco - a lista da juncao fica vazia (GAP-PRD-158, GAP-PRD-159)
- `39822c10` test(integracao): a validade da reserva e conferida no relogio da loja, em qualquer fuso de maquina
- `4f44f67e` merge(remediacao): integra a frente ECO (branch int/eco, juntada de rem/eco)
- `5f2623e9` fix(integracao): o fiado da politica do balcao vence no dia da loja, e nao no de Greenwich
- `263d597c` fix(integracao): o teste do cupom vencido conta o dia da loja, e não o de Greenwich
- `4935bbbf` merge(remediacao): integra a frente ECO (branch rem/eco)
- `425962f0` fix(fis): o painel da fila e o da contingencia conferem o contrato - a tela de Documentos para de apagar (GAP-PRD-020, GAP-PRD-098)
- `93438af9` fix(integracao): os testes de tela respondem a pergunta da barra de conexao
- `2ab49821` fix(fis): a prontidao tributaria volta a ser texto - o separador da chave vira escape (GAP-PRD-095)
- `59a89626` test(telas): nenhuma tela volta ao diálogo do navegador, e todo modal prende o foco (GAP-PRD-158, GAP-PRD-159)
- `bf4cf5ee` docs(remediacao): journal e notas de banco do lote FIS/F7 (GAP-PRD-051, GAP-PRD-176, GAP-PRD-096, GAP-PRD-181, GAP-PRD-163)
- `53642641` fix(telas): o foco fica preso também nos diálogos do PDV e da maquininha (GAP-PRD-159)
- `126d9ae4` feat(fiscal+pdv): a NFC-e no Finalizar vira decisao do dono - manual por padrao, automatica quando a venda esta pronta (GAP-PRD-163)
- `66769ce9` fix(integracao): quatro regras que a junção da DEP cruzou
- `fb4cb82c` merge(remediacao): integra a frente PAG (branch rem/pag)
- `14f87f2a` feat(compras+fiscal): o XML de entrada completa o fornecedor, guarda a tributacao declarada e rele as notas antigas (GAP-PRD-181)
- `9e93457a` chore(eco): StorefrontService.ts volta ao fim de linha LF do repositório
- `bc19ac09` merge(remediacao): integra a frente DEP (branch rem/dep)
- `9eb4e80c` feat(telas): o fechamento mostra o SHA-256 do pacote baixado e confere um pacote recebido (GAP-PRD-176)
- `1ef9f6fc` fix(contador): o pacote imprime o dia da loja e prova o que e - SHA-256 no manifesto, no LEIA-ME, no download, na trilha e no e-mail (GAP-PRD-051, GAP-PRD-176)
- `25ed241f` fix(pag): a varredura das portas devolve a vez ao laco de eventos entre os casos
- `401f475f` fix(eco): a devolucao entra na ordem de exclusao e o teste da vigencia tem categoria que existe
- `1d2efea8` fix(fiscal): as rotas fiscais legadas saem do ar - a travessia de empresa pelo id e as respostas cravadas morrem com elas (GAP-PRD-096)
- `6d69585c` test(servidor): os testes que abrem processo externo têm prazo de processo externo
- `3e372e49` docs(remediacao): o journal da DEP aponta o commit certo da correcao do byte NUL (GAP-PRD-047, GAP-PRD-048)
- `c161fc75` docs(remediacao): verificacao da frente DEP — uma linha por gap; GAP-PRD-048, 145 e 144 resolvidos; 140, 142, 210 e 075 abertos
- `9835bda4` fix(banco): um indice por pergunta — o razao de estoque deixa de pagar dois indices iguais (GAP-PRD-144)
- `a9736869` feat(sistema): o relogio da loja e conferido no ar — o boot avisa e a tela Sistema mostra quando o corte do dia vai divergir (GAP-PRD-145)
- `b004f4f9` feat(sync): a projecao na central se mostra — o erro com hora, a ultima aceita e a pergunta a central (GAP-PRD-048)
- `032a3683` fix(dep): o SyncService volta a ser texto — sem byte NUL literal e com LF no repositorio (GAP-PRD-047)
- `5361eb70` feat(migracao): passo 85 — a consolidação da remediação de produção
- `61fb55c4` fix(integracao): o teste da foto da OS segue o link assinado
- `e595fc04` docs(remediacao): journal e migracoes da frente ECO, lote E6 (GAP-PRD-029, 071, 207, 195, 196)
- `f7a4caf2` fix(frete+portal): prazo e inteiro de dias uteis e a data prometida sai do calendario da loja (GAP-PRD-195, GAP-PRD-196)
- `3cc838d3` fix(catalogo+prontidao): sem foto e aviso, nao bloqueio — uma regua so (GAP-PRD-207)
- `259d8487` fix(vitrine): pagina com teto e catalogo decorado guardado enquanto nada muda (GAP-PRD-071)
- `56ee82fe` fix(pedidos+pagamento): o boleto segura a reserva ate o banco poder confirmar (GAP-PRD-029)
- `089be4ba` docs(remediacao): journal e notas de banco do lote FIS/F6 (GAP-PRD-026, GAP-PRD-024)
- `98aa1160` feat(telas): a OS paga mostra a NFC-e das pecas e a NFS-e da mao de obra, e o fiscal configura a NFS-e (GAP-PRD-024)
- `1ae62ebd` feat(fiscal+oficina): a OS paga tem caminho fiscal - pecas na NFC-e, mao de obra na NFS-e (GAP-PRD-024)
- `7b44c3ea` test(pjmotors): a unidade vendida carrega a linha da venda por onde saiu (GAP-PRD-026)
- `82c7ec75` fix(telas): o foco fica preso no diálogo e volta a quem abriu (GAP-PRD-159)
- `a9402381` fix(integracao): o teste dos botões latentes de Orçamentos lê pela página, como a tela
- `cf5d71c7` docs(remediacao): journal do lote PAG/P6 — a fila sobe sozinha, a recusa se regulariza, o cupom sai pelo agente e a prontidao diz o que falta (GAP-PRD-044, GAP-PRD-045, GAP-PRD-046, GAP-PRD-082, GAP-PRD-083, GAP-PRD-203)
- `f7da2094` docs(remediacao): journal do lote D5 da frente DEP (GAP-PRD-175, 143, 066, 047, 135 resolvidos; 048, 145, 140, 144, 142, 210 abertos)
- `d6269dd7` feat(pag): a prontidao de go-live lista, por operacao, a taxa de operadora, a impressora e o agente que faltam (GAP-PRD-083, GAP-PRD-203, GAP-PRD-082)
- `38f97c4e` feat(pag): o cupom sai sozinho na termica e a gaveta abre no Finalizar, pelo agente local do caixa (GAP-PRD-082)
- `2ceb03fe` fix(telas): o motivo e a confirmação saem do diálogo do navegador (GAP-PRD-158)
- `933d2c36` fix(sync): central fora do ar nao mata a fila — transporte tenta para sempre, so a recusa vira dead, e o lote recusado isola o culpado (GAP-PRD-047)
- `a63470c9` merge(remediacao): integra a frente SEG (branch rem/seg)
- `a0392d25` fix(uploads): a imagem da loja nao carrega script — SVG sai, os bytes decidem o tipo e /uploads sai com sandbox (GAP-PRD-066)
- `6f56f66b` docs(remediacao): journal e migracoes da frente ECO, lote E5 (GAP-PRD-032, 033, 197, 194, 123)
- `9d51033d` feat(promocoes+cupons): o produto se busca, a promocao se edita, e o cliente digita o cupom no carrinho (GAP-PRD-032, 033, 197, 194, 123)
- `5d910f9e` feat(promocoes+cupons): o servidor confere a promocao, ela se edita com horario e teto, e o cupom da loja existe (GAP-PRD-032, 033, 197, 194, 123)
- `5ad1724f` test(dinheiro): a guarda que o Money.ts prometia existe — tela e servidor leem o mesmo numero (GAP-PRD-143)
- `38807c12` fix(testes): a suite fica verde a noite e fora de agosto — o relogio dos dois arquivos mora na hora que os derrubava (GAP-PRD-175)
- `a9d634ea` fix(fiscal): o chassi, o motor e o IMEI da unidade vendida saem na nota e no papel (GAP-PRD-026)
- `52328ad5` fix(integracao): o contrato do boot conhece o rastreio agendado, e os comandos do operador valem em clone novo
- `7b89ae71` feat(telas): o diálogo da casa prende o foco, e o motivo e a confirmação vão para a tela (GAP-PRD-159, GAP-PRD-158 — base)
- `20270836` docs(remediacao): journal da frente SEG, verificacao (GAP-PRD-160, GAP-PRD-073, GAP-PRD-136)
- `5eafd3bf` feat(pag): a venda guardada sobe sozinha, a recusa vai para o servidor e o gestor regulariza (GAP-PRD-044, GAP-PRD-045, GAP-PRD-046)
- `4f7e0f1f` fix(seg): o contrato das telas novas se confere na borda, e o menu registra a fila do no restrita
- `bd87de90` docs(remediacao): journal do lote D4 da frente DEP (GAP-PRD-072, 075, 141, 147, 148, 138, 137)
- `22abba1b` merge(remediacao): integra a frente OFI (branch rem/ofi)
- `cb6e8ae2` docs(remediacao): journal e notas de banco do lote FIS/F5 (GAP-PRD-022, GAP-PRD-023, GAP-PRD-179, GAP-PRD-180)
- `8454c0d2` feat(certificado): a prontidao e a tela dizem que a senha do A1 nao esta selada, e o que fazer (GAP-PRD-023, GAP-PRD-179)
- `a01bb4d0` feat(banco): a empresa da linha vira coluna nas colecoes, o filtro por empresa e SQL, e segredo nao troca de dono (GAP-PRD-147)
- `9dd43d63` docs(remediacao): journal da frente SEG, lote S4 (GAP-PRD-073)
- `d8d9b24d` feat(lgpd): o cliente sai mascarado para quem nao atende o cadastro, e o titular ganha exportacao e anonimizacao (GAP-PRD-073)
- `4eb8b9b2` docs(remediacao): journal da frente OFI, verificacao — a reimpressao pela unidade leva o commit do predicado de empresa (GAP-PRD-190)
- `65eefe4a` feat(telas): o cartao do CSC mostra os dois ambientes e grava o de producao antes da virada (GAP-PRD-022, GAP-PRD-180)
- `b18409d3` fix(ofi): a reimpressao pela unidade junta a bancada com a empresa da maquina (GAP-PRD-190)
- `ae294031` fix(fiscal): um CSC por ambiente sem variavel no servidor, e a unidade fiscal e uma so (GAP-PRD-022, GAP-PRD-180)
- `2a2fa8d0` fix(certificado): revogar apaga o arquivo e a senha, e o reenvio nao carrega o carimbo do anterior (GAP-PRD-179)
- `9a004b2b` merge(remediacao): integra a frente FIN (branch rem/fin)
- `3add0f8f` chore(banco): TABLE_NAMES so com colecao que alguem usa, e o caminho para tirar as aposentadas do banco antigo (GAP-PRD-141)
- `067165c2` merge(remediacao): integra a frente EST (branch rem/est)
- `d50e868e` docs(remediacao): journal e migracoes da frente ECO, lote E4 (GAP-PRD-121, 122, 031, 124, 125, 132)
- `a371bd01` fix(legado): a rota que fingia sai, e /crm, /automations e /bi desmontam — um escritor por conceito (GAP-PRD-072, GAP-PRD-075)
- `8eddde10` merge(remediacao): integra a frente EML (branch rem/eml)
- `9df4aed2` docs(remediacao): journal do lote PAG/P5 — o PIX abandonado tem fila, a venda desfeita estorna e o turno nao fecha calado (GAP-PRD-078, GAP-PRD-080, GAP-PRD-081)
- `fc24f6c7` docs(remediacao): journal da frente OFI, lote O4 — pre-venda de moto com chassi, reserva por unidade, vinculo tardio, fronteira PJ x Oficina e dia 1 da PJ Motors (GAP-PRD-025, GAP-PRD-111, GAP-PRD-108, GAP-PRD-109, GAP-PRD-110, GAP-PRD-189, GAP-PRD-112)
- `e3140f78` feat(relatorios+bi+painel): o pedido online pago entra nas vendas do periodo, no vendedor e no BI, pela regua do DRE (GAP-PRD-132)
- `34476746` feat(pag): desistir cancela na maquininha, a conferencia ganha as filas sem venda e de estorno, e fechar a gaveta pede ciencia (GAP-PRD-078, GAP-PRD-080, GAP-PRD-081)
- `5f4d8432` feat(pag): o PIX abandonado tem fila, a venda desfeita estorna na maquininha e o turno nao fecha calado (GAP-PRD-078, GAP-PRD-080, GAP-PRD-081)
- `e5230fd1` fix(oficina+plaquinha): a moto do estoque abre OS sem cliente, a venda a mao do patio e recusada e tem volta pela ficha, e so quem tem bancada gera plaquinha (GAP-PRD-109, GAP-PRD-189, GAP-PRD-110)
- `7c4c5a71` feat(implantacao): uma instancia por arquivo de banco — a segunda API, o db:migrate e a semeadura recusam com a outra no ar (GAP-PRD-137)
- `6e0428f5` merge(remediacao): integra a frente LOG (branch rem/log)
- `5d421245` feat(portal+pedidos): a cliente baixa a nota, acompanha o rastreio e pede a devolucao pelo portal (GAP-PRD-125)
- `dc12706a` fix(banco): a camada de documentos sobe lendo um numero, nao o banco (GAP-PRD-148)
- `ae93817e` feat(pj-motors): a pre-venda de moto fatura com o chassi, segura aquela moto, a vendida sem plaquinha ganha o vinculo e o dia 1 aparece na tela (GAP-PRD-025, GAP-PRD-111, GAP-PRD-108, GAP-PRD-112)
- `1e95a8bb` docs(remediacao): journal e notas de banco do lote FIS/F4 (GAP-PRD-021, GAP-PRD-095, GAP-PRD-129, GAP-PRD-041, GAP-PRD-178)
- `256f1b18` docs(remediacao): journal da frente FIN, verificacao (GAP-PRD-016, GAP-PRD-173)
- `84962837` fix(fin): a memoria da baixa entra no reset, e a passada do Asaas entra no contrato do boot (GAP-PRD-173, GAP-PRD-016)
- `70bd11d5` docs(contador): o questionario manda confirmar o que o XML ja disse, e diz a ST e o regime normal que a nota emite (GAP-PRD-178)
- `a0d45565` feat(telas): o CRT do leiaute, o ICMS do grupo e o atalho do checklist fiscal (GAP-PRD-021, GAP-PRD-095)
- `bdeaa935` feat(fiscal): a ST retida e o regime normal saem na nota, e a prontidao enxerga o grupo tributario (GAP-PRD-021, GAP-PRD-095, GAP-PRD-129)
- `c0090c01` fix(sync): a redacao do payload tira segredo por palavra, e o campo de negocio chega a central (GAP-PRD-138)
- `4163e64b` fix(pedidos+financeiro): o reembolso lanca a saida do dinheiro e o estoque so volta com a mercadoria conferida (GAP-PRD-122, GAP-PRD-031)
- `1bb51a85` docs(remediacao): o journal do GAP-PRD-149 aponta so o commit dele
- `b318039f` docs(remediacao): a frente EST diz que o lote T2 nao pede passo de banco (GAP-PRD-070, GAP-PRD-164)
- `6c34f52c` docs(remediacao): journal da frente SEG, lote S3 (GAP-PRD-052, GAP-PRD-084, GAP-PRD-136, GAP-PRD-149, GAP-PRD-184, GAP-PRD-206, GAP-PRD-054, GAP-PRD-160)
- `8349fa10` feat(auth): "esqueci minha senha" da equipe como escolha do dono, desligada por padrao (GAP-PRD-160)
- `a190bd86` docs(remediacao): journal do lote D3 da frente DEP (GAP-PRD-056, 057, 064, 067, 139, 154)
- `60417836` fix(pedidos): o servidor so aceita a proxima etapa, voltar tem porta e motivo, e o gestor cancela o pedido nao pago (GAP-PRD-121, GAP-PRD-124)
- `99f51e7d` feat(sistema): o roteador /system so tem o que e verdade, ganha a tela Sistema, o erro traz o codigo do log e os documentos apontam para o que existe (GAP-PRD-064)
- `4378eab1` feat(alcada): quem libera nesta operacao fica visivel, com nome (GAP-PRD-054)
- `85878406` docs(remediacao): journal da frente FIN, lote N3 (GAP-PRD-094, GAP-PRD-086, GAP-PRD-172, GAP-PRD-173, GAP-PRD-174, GAP-PRD-177, GAP-PRD-208, GAP-PRD-171, GAP-PRD-169, GAP-PRD-170, GAP-PRD-017)
- `87418615` feat(implantacao): o checklist de cada empresa — um vocabulario so, a tela que resolve e quem resolve (GAP-PRD-067)
- `1b4ba0d6` fix(login): a tela de login so sonda o acesso rapido com a flag de build (GAP-PRD-206)
- `90fd2d2c` fix(oficina): a foto da OS abre por link assinado de uma hora, e nao por endereco publico (GAP-PRD-184)
- `a743c2aa` docs(remediacao): journal do lote PAG/P4 — a maquininha pelo agente local e a tela do modulo (GAP-PRD-014, GAP-PRD-076)
- `aed81487` feat(pag): Configuracoes > Maquininhas e o cartao que espera o PinPad no PDV (GAP-PRD-076, GAP-PRD-014)
- `3abc8796` feat(pag): o programa do agente local fala com o gerenciador TEF pela troca de arquivos (GAP-PRD-014)
- `a1fdfcde` feat(pag): a maquininha de verdade passa pelo agente local — fila de comandos, resultado assinado e caminho por caixa (GAP-PRD-014)
- `8f7c7a8b` feat(asaas): o que cada operacao do grupo ainda precisa para cobrar, num lugar so — e a prova de que a credencial e o unico insumo (GAP-PRD-017)
- `be2c8301` docs(remediacao): journal da frente OFI, lote O3 — quadro com versao e paginacao, OS legada, plaquinha pela tela e identidade da maquina (GAP-PRD-183, GAP-PRD-187, GAP-PRD-188, GAP-PRD-107, GAP-PRD-185, GAP-PRD-190, GAP-PRD-106)
- `483abd4a` fix(telas+equipe): botao que o servidor fecha nao aparece (GAP-PRD-149)
- `34891ccb` docs(remediacao): journal da frente EST, lote T3 (GAP-PRD-087, 088, 089, 090, 165, 166, 167, 168)
- `1d344f2f` fix(sync): repara o core.ts que o commit bed4897 gravou corrompido (GAP-PRD-136)
- `44bd0c32` feat(equipamento): a maquina ganha tipo, placa, km, fotos e contato do dono, e a identidade se corrige pela ficha com motivo (GAP-PRD-106)
- `709e0acb` fix(asaas): cada passo verde da homologacao e uma verificacao executada, e o aviso de fora so conta quando chega (GAP-PRD-169)
- `00256a28` chore(implantacao): o legado sai da arvore, o banco padrao tem um nome so, e a conferencia aponta a sobra da maquina (GAP-PRD-154)
- `bed48974` fix(sync): a fila e do no, e o gerente ve e age na operacao dele (GAP-PRD-136)
- `e9daabcf` fix(compras): o simulador de DF-e nao responde por producao — a ultima linha entre o A1 e o go-live (GAP-PRD-168)
- `aeee8ffe` docs(sync): o teste e os documentos dizem o que o boot faz — o ciclo sobe sempre e so a venda espera offline (GAP-PRD-139)
- `25214958` feat(gestao): a politica de gestao — quem ve dinheiro (padrao seguro) e a regua do valor do estoque, com a confirmacao do contador (GAP-PRD-165, GAP-PRD-166)
- `44faa8bc` fix(banco): o db:migrate migra no Windows, e a versao que se mostra e a do nucleo (GAP-PRD-056, GAP-PRD-057)
- `122cbbbb` fix(bi+painel): atravessar empresa pede o perfil de la, e nao so o vinculo (GAP-PRD-084)
- `097969b2` fix(asaas): as trancas de producao nao dependem da ordem, e a chave de producao e testada em api.asaas.com antes de valer (GAP-PRD-170)
- `8a4b7a16` feat(plaquinha+empresas+estoque): a ficha troca e reimprime o adesivo, a PJ reimprime pela unidade e a operacao liga a plaquinha pela tela (GAP-PRD-107, GAP-PRD-190, GAP-PRD-185)
- `5a1d0e8d` feat(compras): a nota recebida sem conta a pagar ganha a decisao do dono — lancar, lancar paga ou dispensar com motivo (GAP-PRD-088)
- `91bb7c84` fix(produtos): o caixa nao muda o preco de tabela pela API (GAP-PRD-052)
- `8c4773b9` feat(estoque): o inventario conta um local — a Vitrine sem somar o deposito (GAP-PRD-167)
- `4970d524` feat(conciliacao+financeiro): as quitacoes antigas sem baixa ganham lista e botao de decisao, sem nada rodar sozinho (GAP-PRD-171)
- `696940d1` docs(remediacao): journal e migracoes da frente ECO, lote E3 (GAP-PRD-115, 191, 192, 116, 193)
- `e3e07350` feat(compras): devolucao ao fornecedor — parte da compra volta com estoque, credito e o gancho da NF-e de devolucao (GAP-PRD-089)
- `fd7f9223` feat(financeiro): fluxo de caixa projetado — o que entra e sai por dia ou semana, e onde o saldo vai parar (GAP-PRD-094)
- `48cf619c` fix(oficina+quadro): o movimento leva o retrato do card, a coluna pagina pelas antigas e a OS fora das regras tem conserto pela tela (GAP-PRD-183, GAP-PRD-187, GAP-PRD-188)
- `525f8516` feat(loja+portal): o carrinho mora na conta, funde no login, e a sessao desliza (GAP-PRD-193)
- `808b0374` docs(remediacao): journal da frente EML, lote M3 (GAP-PRD-035, GAP-PRD-128, GAP-PRD-130)
- `b6dcfba8` feat(telas): a caixa de NF-e diz quantas faltam e o que fazer com a lida, a senha recusada aparece pelo nome com "Testar conexão", e a fila de e-mails mostra o que falta configurar (GAP-PRD-035, GAP-PRD-128, GAP-PRD-130)
- `97381042` fix(email-entrada): a caixa de NF-e para de entupir na 25ª, a senha recusada tem nome e teste, e cada empresa vê o que falta para os e-mails saírem (GAP-PRD-035, GAP-PRD-128, GAP-PRD-130)
- `6ac38e22` feat(comissoes+financeiro): o titulo da comissao leva ao fechamento, e o historico de fechamentos ganha tela (GAP-PRD-174)
- `79799175` feat(compras): o pedido de compra sai do sistema — A4 imprimivel, e-mail ao fornecedor e o rotulo que diz o que faz (GAP-PRD-090)
- `79eca01a` feat(portal+loja): o endereco se edita, tem tipo e destinatario, e o pedido guarda o retrato em colunas (GAP-PRD-115)
- `75eb8d89` feat(conciliacao): a lista do extrato diz quantas linhas existem e pagina, em vez de cortar em 500 calada (GAP-PRD-177)
- `5a7c0096` docs(remediacao): journal do lote FIS/F3 (GAP-PRD-020, GAP-PRD-098)
- `d7a3a137` feat(fiscal): a NFC-e nasce off-line na queda da SEFAZ, com DANFCE de contingencia e volta sozinha (GAP-PRD-098)
- `0c22d9e4` feat(estoque): a reserva presa tem porta — a posicao diz por que e a gerencia solta com motivo (GAP-PRD-087)
- `ebccbe35` docs(remediacao): journal do lote D2 da frente DEP (GAP-PRD-011, 012, 058, 059, 068)
- `99fcd7c0` fix(bi): a margem do BI usa o custo gravado na venda, o mesmo do CMV do DRE (GAP-PRD-086)
- `17f6525b` fix(financeiro): o "em aberto" conta os abertos, o saldo da conta segue o carimbo, e a baixa repetida nao vira duas (GAP-PRD-208, GAP-PRD-172, GAP-PRD-173)
- `81b20ba3` feat(backup): a volta do bucket sem programar — listar, baixar o banco, restaurar as fotos e o roteiro do disco morto (GAP-PRD-012)
- `98422454` feat(backup): o estado do backup aparece — rota de verdade, conferencia do bucket e a tela Configuracoes > Backup (GAP-PRD-011, GAP-PRD-068)
- `d6c20243` feat(backup): o diario nao para o balcao — copia numa worker, fotos uma a uma por sha256 e hora marcada (GAP-PRD-058)
- `bda3ca31` fix(portal): cadastro com nome, senha que se defende e tetos nas portas publicas (GAP-PRD-192, GAP-PRD-116)
- `a6b8afa8` docs(logistica): verificacao da frente LOG — journal com o commit da verificacao e migracoes com o L1 e o resumo para a consolidacao (GAP-PRD-117, GAP-PRD-120)
- `37f26244` fix(logistica): o formulario da etiqueta e o da credencial nao apagam a primeira correcao do operador (GAP-PRD-120, GAP-PRD-117)
- `9f63d779` feat(fiscal): a fila anda sozinha — trabalhador por empresa, volta da SEFAZ e o gesto na tela (GAP-PRD-020)
- `dbb2fe24` fix(loja): o visitante mostra CPF valido e e-mail antes de reservar (GAP-PRD-191)
- `a9a63b87` docs(remediacao): journal da frente SEG, lote S2 (GAP-PRD-053, GAP-PRD-069, GAP-PRD-074, GAP-PRD-055, GAP-PRD-157, GAP-PRD-156)
- `ad556625` docs(remediacao): journal do lote PAG/P3 — devolucao pelo liquido e dinheiro sempre com gaveta (GAP-PRD-009, GAP-PRD-050, GAP-PRD-161, GAP-PRD-134)
- `ed2a4207` test(contador): o Content-Disposition segue exposto ao lado do X-Perfil-Em-Vigor (GAP-PRD-053)
- `089fc5ed` feat(pag): a tela de devolucoes anuncia o que o servidor devolve e tira da gaveta do caixa deste computador (GAP-PRD-009, GAP-PRD-050, GAP-PRD-161)
- `96fcb09d` fix(pag): a devolucao devolve o que entrou, e o dinheiro so passa por gaveta aberta (GAP-PRD-009, GAP-PRD-050, GAP-PRD-161, GAP-PRD-134)
- `46c393ec` docs(remediacao): journal da frente OFI, lote O2 — quem abre e mexe na OS, devolucao de peca, portal, eventos de status e custo da peca (GAP-PRD-099, GAP-PRD-102, GAP-PRD-186, GAP-PRD-103, GAP-PRD-182, GAP-PRD-100, GAP-PRD-101)
- `7a07e549` feat(seguranca): CSP e HSTS na API e CSP da tela no build (GAP-PRD-156)
- `c699bcfe` fix(oficina+portal+sync+cmv): quem abre e mexe na OS segue a regua de quem faz, o portal so decide na bancada, o status sobe para a central e a peca leva o custo ao CMV (GAP-PRD-099, GAP-PRD-102, GAP-PRD-186, GAP-PRD-103, GAP-PRD-182, GAP-PRD-100, GAP-PRD-101)
- `6661d005` docs(remediacao): journal da frente EML, lote M2 (GAP-PRD-036, GAP-PRD-037, GAP-PRD-198, GAP-PRD-199, GAP-PRD-200)
- `f899ec1a` feat(telas): a OS diz o que o cliente recebeu, a fila dá nome a cada mensagem e escolhe o remetente, e o portal não promete e-mail desligado (GAP-PRD-036, GAP-PRD-198, GAP-PRD-199, GAP-PRD-200)
- `d25407b4` feat(email): a oficina e o pós-venda avisam o cliente, cada empresa entrega a própria fila com o remetente que o dono escolher, e o portal só promete o e-mail que vai chegar (GAP-PRD-036, GAP-PRD-037, GAP-PRD-198, GAP-PRD-199, GAP-PRD-200)
- `26995b88` docs(remediacao): journal da frente EST, lote T2 (GAP-PRD-070, GAP-PRD-164)
- `4cc0eb3c` feat(publicacao): o proxy nao declarado aparece, e a renovacao que falha nao desloga o caixa (GAP-PRD-055)
- `38323e31` fix(auth): atras do proxy, o bloqueio por par continua sendo por par (GAP-PRD-074)
- `bd12f7fe` feat(listas): a tela diz "mostrando 1-100 de 1.180", anda de pagina e escolhe cliente por busca (GAP-PRD-070, GAP-PRD-164)
- `fa9411ed` fix(log): um Error no log diz qual foi o erro — mensagem, pilha curta, code e causa (GAP-PRD-059)
- `37fcc6c0` test(conciliacao): o relogio para no meio de agosto, e o teste deixa de medir a data de hoje
- `4ec2ce21` fix(sessao): desligou, caiu na hora — o token confere a conta a cada requisicao (GAP-PRD-053)
- `5358205e` docs(remediacao): journal da frente FIN, lote N2 (GAP-PRD-016, GAP-PRD-092, GAP-PRD-114, GAP-PRD-155, GAP-PRD-093, GAP-PRD-077)
- `8107b2d5` docs(remediacao): journal do lote LOG/L2 — GAP-PRD-120, 119, 118, 034, e o registro de migracoes da frente
- `47d82c83` feat(telas): envio na ficha do pedido, despacho com quem leva, rastreio com link no portal e a prontidao do dia 1 (GAP-PRD-120, GAP-PRD-119, GAP-PRD-118, GAP-PRD-034)
- `2cfc1035` feat(logistica): a etiqueta sai do provedor ligada ao pedido, o rastreio volta com origem e Correios/Jadlog dizem o que sao (GAP-PRD-120, GAP-PRD-119, GAP-PRD-118, GAP-PRD-034)
- `62a4afcc` docs(remediacao): journal da frente ECO, lote E2 (GAP-PRD-027)
- `9c164860` feat(pdv+asaas): o PIX do balcao nasce no ERP, e a linha pendente deixa de ser beco (GAP-PRD-077)
- `c31c36c6` fix(listas): a lista diz quantas existem, anda de pagina e para no teto (GAP-PRD-070, GAP-PRD-164)
- `14b39af3` docs(remediacao): journal do lote FIS/F2 (GAP-PRD-004, GAP-PRD-005, GAP-PRD-018, GAP-PRD-019)
- `f6c85538` feat(loja+portal): o botao do Google, a volta que conclui e a tela do dono (GAP-PRD-027)
- `34e73451` feat(portal): entrar com Google — OIDC com PKCE, id_token pela chave publicada e provedor de teste (GAP-PRD-027)
- `8d71f1f0` fix(sessoes): a sessao se acha pelo id e a sessao morta sai da tabela (GAP-PRD-069)
- `0462b746` feat(fiscal): a tela cancela, corrige e inutiliza pela SEFAZ, e o dono escolhe cofre ou senha (GAP-PRD-005)
- `fa45994c` fix(fiscal): o ato com a SEFAZ segue a procedencia da nota, e em producao so adapter real transmite (GAP-PRD-005, GAP-PRD-018)
- `35bb4e7a` fix(api): corpo quebrado e erro de quem mandou, e nao "Erro interno" (GAP-PRD-157)
- `f708e82f` docs(remediacao): journal do lote PAG/P2 — caixas e terminais, token do computador e gaveta de outro dia (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150, GAP-PRD-131)
- `ce00afb8` feat(pag): a tela de caixas e terminais, o PDV que sabe de qual caixa e, e o aviso da gaveta de outro dia (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150, GAP-PRD-131)
- `c860bd7a` docs(remediacao): journal do lote D1 da frente DEP (GAP-PRD-013, 060, 061, 062, 063, 151, 153)
- `df7aceda` feat(pag): cada caixa com a sua gaveta, o token preso ao caixa e a gaveta esquecida apontada (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150, GAP-PRD-131)
- `7ee03056` feat(loja+asaas): "parcele em ate Nx" passa a ser verdade — o cartao vai parcelado ao provedor (GAP-PRD-114)
- `e5952148` fix(fiscal): o evento vai ao host do modelo, com a hora do leiaute e o CNPJ do emitente (GAP-PRD-019)
- `b8fc6963` fix(config): o LOG_LEVEL vale, a chave morta sai, e os tres exemplos documentam tudo o que o codigo le
- `8bf83461` fix(fiscal): o protocolo com Id e lido dentro do infProt — autorizacao real deixa de virar rejeicao (GAP-PRD-004)
- `fb3874fd` feat(implantacao): a publicacao de referencia sai do repositorio — telas, HTTPS, servico, log e a conferencia
- `5553dfcf` feat(conciliacao): a conciliacao pergunta ao provedor, e o pagamento sobre cobranca cancelada deixa de sumir (GAP-PRD-016)
- `e95b35dd` docs(remediacao): journal da frente OFI, lote O1 — caixa da oficina (GAP-PRD-042, GAP-PRD-104, GAP-PRD-209, GAP-PRD-105)
- `411f0406` feat(oficina+pdv): o caixa da oficina recebe a OS no PDV com a cesta do balcao, o reenvio devolve o recebimento e a OS paga ganha estorno (GAP-PRD-042, GAP-PRD-104, GAP-PRD-209, GAP-PRD-105)
- `474ebd7b` feat(financeiro): a cobranca paga do titulo se estorna pelo ERP, com a baixa desfeita sob confirmacao (GAP-PRD-092)
- `b9f62add` docs(remediacao): journal da frente EML, lote M1 (GAP-PRD-007, GAP-PRD-038, GAP-PRD-065, GAP-PRD-201)
- `95d1de1a` feat(telas): a fila de e-mails mostra o motivo e reenvia, e as duas telas dizem que o .env vale sem reinício (GAP-PRD-038, GAP-PRD-065, GAP-PRD-007)
- `6d929ce7` fix(email): o segredo do cliente sai da fila e da tela, a falha espaça e volta, o .env vale sem reinício e o aviso não derruba o fato (GAP-PRD-007, GAP-PRD-038, GAP-PRD-065, GAP-PRD-201)
- `32caf1f1` fix(asaas): o retry da fila e da empresa do token, e a rota que fingia diz qual e a de verdade (GAP-PRD-155, GAP-PRD-093)
- `ed211ec9` docs(remediacao): journal da frente EST, lote T1 (GAP-PRD-015, GAP-PRD-085, GAP-PRD-204)
- `50b66466` fix(compras): a entrada manual diz que nunca teve XML, em vez de fingir que o perdeu (GAP-PRD-204)
- `3cdbbc41` docs(remediacao): journal da frente SEG, lote S1 (GAP-PRD-010, GAP-PRD-152, GAP-PRD-040, GAP-PRD-202)
- `7b53e078` fix(compras): o item da nota casa com o produto que ja existe, e o vinculo so vale em conferencia (GAP-PRD-015, GAP-PRD-085)
- `ca56810b` fix(processo): a rejeicao solta vira log, a excecao desliga com 1, e o desligamento tem prazo e fecha o banco
- `26c7e364` docs(remediacao): journal e migracoes da frente ECO, lote E1 (GAP-PRD-006, 043, 028, 133, 205)
- `38e526aa` fix(docker): o contexto leva so codigo, o dado fica no volume e o compose nao traz segredo
- `9d3c286a` feat(loja+portal): comprar exige conta e o pedido nasce na conta (GAP-PRD-043, GAP-PRD-028)
- `73b42a37` fix(seed): o seed cria o que falta com senha provisoria e nao reescreve o que o dono ja configurou (GAP-PRD-040)
- `f16e460b` fix(auth): a senha provisoria so abre a etapa de troca, e quem recusa e o servidor (GAP-PRD-202)
- `9c830f64` fix(equipe): gerente nao mexe em conta de dono, e a conta que entra em varias operacoes tem alavanca propria (GAP-PRD-010, GAP-PRD-152)
- `a3df5fb7` docs(remediacao): journal e notas de banco do lote FIS/F1 (GAP-PRD-003, GAP-PRD-097)
- `cee7578e` fix(fiscal): a assinatura resume o que viaja — C14N de verdade pela xml-crypto (GAP-PRD-003)
- `143504f3` docs(remediacao): journal do lote LOG/L1 — GAP-PRD-030, 126, 127, 117
- `5451630d` feat(fiscal): o leiaute passa pelo XSD oficial antes do numero (GAP-PRD-097)
- `a4e22cca` docs(logistica): o estado do Melhor Envio diz o que o codigo faz, e a tela Integracoes para de repetir frase fixa (GAP-PRD-127)
- `84255c9f` docs(remediacao): journal do lote PAG/P1 e a correcao do dado da maquininha de teste (GAP-PRD-001, GAP-PRD-008, GAP-PRD-079, GAP-PRD-162)
- `7a58d474` feat(logistica): o gestor cola o token do Melhor Envio na tela, testa e ve se o checkout cobra (GAP-PRD-117, GAP-PRD-126)
- `b6ce6bd3` fix(logistica): o token de producao do Melhor Envio cota a producao, e variavel de teste nao decide o checkout (GAP-PRD-030, GAP-PRD-126)
- `dd7b1863` feat(pag): o gestor desliga a maquininha pela tela, e o balcao sabe antes de cobrar quando ela e de teste (GAP-PRD-001)
- `25fce099` fix(pag): a maquininha de teste nao opera onde ha dinheiro, a cobranca tem uma chave so, e estorno e comprovante dizem o que aconteceu
- `4313dbe0` fix(portal): os dados da pessoa moram na conta (GAP-PRD-133, GAP-PRD-205)
- `6abf1baa` docs(remediacao): journal da frente FIN, lote N1 (GAP-PRD-002, GAP-PRD-113, GAP-PRD-091, GAP-PRD-049)
- `02abad14` feat(integracoes): a tela do Asaas diz qual URL cadastrar e se o aviso esta chegando (GAP-PRD-002)
- `3161ebab` fix(asaas): o aviso que o painel ja manda passa a baixar, e nenhuma cobranca nasce duas vezes (GAP-PRD-002, GAP-PRD-113, GAP-PRD-091, GAP-PRD-049)
- `7893a43b` fix(loja+portal): o CPF de outra pessoa nao sequestra o cadastro dela (GAP-PRD-006)
- `5433fdc8` feat(ops): stack descartavel que nao consegue apontar para a instalacao da loja
- `8caa1f34` docs(remediacao): plano das 10 frentes, regras dos agentes e journal
- `2d1a7846` fix(testes): a suite nao sai para a rede nem fala com a instalacao da loja (GAP-PRD-135)
- `512279e3` docs(auditoria): linha de base da remediacao — relatorio de prontidao e registro das 210 fichas

