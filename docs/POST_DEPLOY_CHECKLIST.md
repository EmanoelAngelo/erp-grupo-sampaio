# Post-deploy checklist — Grupo Sampaio ERP 1.0.0

Execute após o deploy em produção. Cada item aponta para uma tela ou comando que
existe (GAP-PRD-064: este checklist mandava para uma tela de "go-live" que nunca
existiu; `server/tests/os-documentos-apontam-para-o-que-existe.test.ts` confere).

## Infraestrutura

- [ ] **Modo do processo**: `DEVORA_API_ENV=production` **e**
      `NODE_ENV=production` no `.env` da API, e a API reiniciada. É a variável
      que faz as outras valerem: fora de produção, a chave de sandbox e o token
      de webhook do `.env` valem COMO SE fossem da operação
      (`asaasEnvFallbackAllowed`) — Integrações › Asaas mostra "Sandbox:
      configurada" com a dica de uma chave que não é da empresa, o PIX do balcão
      nasce nessa conta e a homologação em sandbox pode ser aprovada contra ela,
      abrindo o portão de produção com uma prova que não é da operação. O mesmo
      interruptor libera o provedor de TESTE da maquininha
      (`mockProviderBlocked`), que aprova cartão sem dinheiro trocar de mãos.
      Confira em Configurações › Implantação (item "Ambiente", sem BLOQUEIA) e
      em Integrações › Asaas → o que falta (item `MODO_DO_PROCESSO` ausente)
- [ ] `GET /api/v1/version` — `appVersion: 1.0.0`, e `databaseVersion` igual a
      `databaseTargetVersion` (`databaseSituation: EM_DIA`)
- [ ] `GET /api/v1/health` ok e `GET /api/v1/readiness` 200
- [ ] `node server/dist/db/status.js` — `"situacao": "EM_DIA"` (sai com 0)
- [ ] Configurações › Sistema: **NÚCLEO PRONTO**, e as chaves do servidor como
      "própria" (nunca "padrão de desenvolvimento")
- [ ] Configurações › Implantação sem nenhum BLOQUEIA (HTTPS, serviço, ambiente,
      nenhuma variável aposentada, dados fora da pasta do sistema)
- [ ] CORS com a origem real (`DEVORA_FRONTEND_ORIGIN`), sem `*`
- [ ] `GET /api/v1/core/system/secrets-readiness` (sessão de gestor) —
      `publicacao.estado` é `PROXY_DECLARADO` atrás de proxy (ou
      `SERVIDO_DIRETO` sem proxy); `PROXY_NAO_DECLARADO` pede
      `DEVORA_TRUST_PROXY` = nº de saltos e reinício

## Autenticação

- [ ] Login do administrador
- [ ] Login de um caixa (ex.: Gringa)
- [ ] Troca de senha obrigatória do administrador inicial: login `admin` com a
      senha de `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` abre a etapa de troca, e
      `GET /api/v1/core/products` com esse token responde 403
      `API_PASSWORD_CHANGE_REQUIRED`
- [ ] Senhas iniciais trocadas — o checklist de cada empresa lista as provisórias
- [ ] `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` apagada do `.env` ("Administrador
      inicial" em OK na conferência). O bootstrap (`db:bootstrap`, o mesmo
      `db:seed`) nunca altera conta existente: rodado de novo, o relatório diz
      "nenhuma conta foi criada nem alterada"
- [ ] Nenhuma conta de demonstração no banco (elas só nascem pelo seed de
      desenvolvimento, que recusa produção)

## Core smoke

- [ ] Abrir caixa no PDV
- [ ] Localizar produto → venda → pagamento → finalizar
- [ ] Estoque atualizado
- [ ] Fechar caixa
- [ ] Oficina: Kanban / OS
- [ ] Loja online: administração da vitrine
- [ ] BI
- [ ] Integrações abrem mostrando o que falta, sem erro

## Operações

- [ ] Backup executado e verificado (`npm run backup`, `npm run backup:verify`)
      e Configurações › Backup sem nenhum FALHOU
- [ ] Logs sem segredo, PAN ou CVV
- [ ] Conciliações sem divergência crítica: Financeiro › Conciliação,
      Asaas › Conciliação, conferência de maquininha, Banco central sem evento
      parado, E-mails sem falha

## Integrações externas (devem permanecer OFF até a homologação de cada uma)

- [ ] `ASAAS_PRODUCTION_ENABLED=false`
- [ ] `NFE_PRODUCTION_ENABLED=false`
- [ ] `NFCE_PRODUCTION_ENABLED=false`
- [ ] `LOGISTICS_PRODUCTION_ENABLED=false`
- [ ] `PAYMENT_TERMINAL_PRODUCTION_ENABLED=false`
- [ ] `ECOMMERCE_PRODUCTION_ENABLED=false`

## Implantação de cada empresa

- [ ] Configurações › Empresas do grupo → **Checklist** de cada uma: nenhum item
      PENDENTE, DIVERGENTE ou AUTO-DETECTADO (confirme o que o sistema achou);
      BLOQUEADO EXTERNAMENTE só no que depende de insumo de fora (certificado,
      SEFAZ, credencial, equipamento); N.A. só com motivo escrito
