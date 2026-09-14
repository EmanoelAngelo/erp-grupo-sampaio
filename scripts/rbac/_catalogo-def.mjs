// Definição do catálogo + regras rota -> capability + verificador de equivalência dia-1.
// Siglas: L=gerente_loja O=gerente_oficina E=estoquista T=atendente C=operador_caixa (legado)
// CL=operador_caixa_loja CO=operador_caixa_oficina M=mecanico K=contador.
// admin_geral e gestor recebem TODAS as capabilities (modelos de sistema), por isso P=[] = "só os donos".
import fs from 'node:fs';

const FULL = { L:'gerente_loja', O:'gerente_oficina', E:'estoquista', T:'atendente', C:'operador_caixa', CL:'operador_caixa_loja', CO:'operador_caixa_oficina', M:'mecanico', K:'contador' };
const TODOS = ['C','CL','CO','E','L','M','O','T'];

// [code, area, pagina, label, descricao, escopo, tipo, P]
const CAPS = [
  // ---------------------------------------------------------------- GRUPO / SISTEMA
  ['group.admin','Grupo','Empresas do grupo / Usuários','Administrar o grupo','Responde pelo grupo: entrega capabilities de escopo grupo, aplica o modelo "Administrador do grupo", entra automaticamente em empresa nova (substitui respondePeloGrupo/listGroupAdminIds). Só é entregue por quem já a tem.','grupo','gerir',[]],
  ['group.companies.manage','Grupo','/sistema/empresas','Empresas do grupo','Listar, criar empresa (com o primeiro gerente) e ligar plaquinha por empresa. GET/POST /core/companies, PATCH /core/companies/:id/equipment-tags.','grupo','gerir',[]],
  ['group.dashboard.view','Grupo','Painel do grupo','Painel do grupo (visões consolidadas)','Visões que atravessam as empresas: certificados A1 de todas (GET /core/fiscal/certificates/group) e Asaas do grupo (GET /core/integrations/asaas/grupo).','grupo','ler',[]],
  ['group.audit.view','Grupo','/sistema/usuarios (histórico da pessoa)','Auditoria do grupo','Ler a trilha de auditoria de todas as empresas em que a capability vale, numa leitura só (histórico de uma pessoa entre empresas). Nova: hoje a trilha só é lida empresa a empresa pelos donos.','grupo','ler',[]],
  ['audit.view','Relatórios','/sistema/relatorios/auditoria','Auditoria da empresa','Trilha de auditoria e liberações de gestor da empresa ativa (GET /core/audit, GET /core/authorizations).','empresa','ler',[]],
  ['permissions.templates.manage','Usuários','/sistema/usuarios/modelos','Modelos de permissão','Criar, editar, duplicar e arquivar modelos (Operador de Caixa, Gerente de Loja…). Nova: não existe tela nem rota hoje.','grupo','gerir',[]],
  ['system.status.view','Sistema','/sistema/configuracoes/sistema','Estado do sistema','Versão, prontidão e saúde (GET /system/readiness, GET /system/release).','grupo','ler',[]],
  ['system.secrets.view','Sistema','/sistema/configuracoes/sistema','Cofre de segredos (conferência)','Quais segredos existem e quais faltam, sem o valor (GET /core/system/secrets-readiness).','grupo','ler',[]],
  ['system.deploy.view','Sistema','/sistema/configuracoes/implantacao','Implantação (ver)','Checklist de implantação do grupo e por empresa (GET /system/implantacao*).','grupo','ler',[]],
  ['system.deploy.manage','Sistema','/sistema/configuracoes/implantacao','Implantação (marcar itens)','Marcar/desmarcar item do checklist de implantação (PUT/DELETE /system/implantacao/empresas/:id/itens/:item/marca).','grupo','gerir',[]],
  ['system.backup.view','Sistema','/sistema/configuracoes/backup','Backup (ver)','Estado do backup do banco das seis empresas (GET /system/backup/status).','grupo','ler',[]],
  ['system.backup.manage','Sistema','/sistema/configuracoes/backup','Backup (conferir destino)','Conferir o bucket de backup (POST /system/backup/conferir-bucket).','grupo','gerir',[]],
  ['integrations.google_login.manage','Integrações','/sistema/integracoes/google','Entrar com Google (loja)','Configuração da instalação para o login Google do portal do cliente (GET/PUT /core/portal/login-google).','grupo','gerir',[]],
  ['devices.view','Integrações','/sistema/configuracoes/terminais','Tokens de terminal (ver)','Listar os computadores registrados como terminal (GET /auth/devices).','empresa','ler',[]],
  ['devices.manage','Integrações','/sistema/configuracoes/terminais','Tokens de terminal (registrar/revogar)','Registrar computador como terminal de um caixa e revogar o token (POST /auth/device/enroll, /auth/device/:id/revoke).','empresa','gerir',[]],
  ['users.password_recovery.manage','Usuários','/sistema/usuarios','"Esqueci minha senha" da equipe','Ligar/desligar a recuperação de senha por e-mail na empresa (GET/PUT /core/team/recuperacao-de-senha).','empresa','gerir',[]],
  ['settings.management_policy.manage','Configurações','/sistema/configuracoes/politica-de-gestao','Política de gestão (salvar)','Decidir se a equipe vê dinheiro no painel e custo do estoque (PUT /core/management-policy).','empresa','gerir',[]],
  ['fiscal.certificate.manage','Fiscal','/sistema/fiscal/certificado','Certificado A1','Ver, enviar e revogar o certificado que assina nota em nome da empresa (GET/POST /core/fiscal/certificate, /revoke).','empresa','gerir',[]],
  ['fiscal.policy.manage','Fiscal','/sistema/fiscal/configuracao','Políticas fiscais e produção','Política de emissão, de atos, de contingência e liberação de produção na SEFAZ (PUT emission-policy/acts/contingency policy, POST production-unlock).','empresa','gerir',[]],

  // ---------------------------------------------------------------- USUÁRIOS
  ['users.view','Usuários','/sistema/usuarios','Usuários e equipe (ver)','Lista da equipe da empresa, modelos que quem pergunta pode entregar (GET /core/team, /core/team/profiles).','empresa','ler',['L','O']],
  ['users.manage','Usuários','/sistema/usuarios','Usuários e equipe (cadastrar, editar, vincular)','Criar pessoa, editar nome/e-mail, aplicar/personalizar modelo, escopo de PDV e bancada, vincular conta existente, remover desta empresa (POST/PATCH /core/team*, /team/link, /remove-from-company).','empresa','gerir',['L','O']],
  ['users.deactivate','Usuários','/sistema/usuarios','Desativar/reativar conta','Desliga a conta em TODAS as empresas da pessoa (POST /core/team/:id/active); exige alcance em todas elas.','empresa','gerir',['L','O']],
  ['users.reset_password','Usuários','/sistema/usuarios','Redefinir senha','Definir senha provisória e derrubar as sessões (POST /core/team/:id/password); exige alcance em todas as empresas do alvo.','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- PAINEL
  ['dashboard.view','Painel','/sistema/painel','Página principal do gestor','Painel do dia da empresa (GET /core/dashboard) e leitura da política de gestão. Atravessa para outra empresa só onde a pessoa também tem esta capability.','empresa','ler',['E','L','O','T']],
  ['dashboard.money.view','Painel','/sistema/painel','Dinheiro no painel','Faturamento e valores no painel mesmo com a política de gestão desligada (veDinheiroDoPainel).','empresa','ler',['L','O']],

  // ---------------------------------------------------------------- PDV
  ['pdv.sell','PDV','/pdv','Vender no PDV','Montar carrinho, finalizar venda, Pix, venda offline, pedir liberação (POST /core/sales, /offline-sales, /pdv/pix-asaas). Exige também o escopo do PDV/caixa.','pdv','operar',['C','CL','CO','L','O','T']],
  ['pdv.cash.operate','PDV','/pdv, /sistema/caixa','Operar caixa (gaveta)','Abrir, suprir, sangrar, fechar e reabrir o turno; abrir a gaveta; receber título no balcão (POST /core/cash/*, /print/drawer/open). Exige o escopo do caixa.','pdv','operar',['C','CL','CO','L','O']],
  ['pdv.payment.charge','PDV','/pdv','Cobrar na maquininha','Cobrança no terminal de cartão, desistir e confirmar teste (POST /core/pdv/terminal/charge, /desistir, /confirmar-teste).','pdv','operar',['C','CL','CO','L','O']],
  ['pdv.backoffice','PDV','/pdv (retaguarda)','Retaguarda pelo balcão','O caixa cadastra produto rápido, faz entrada de NF-e/CT-e e ajusta estoque pelo balcão (POST /core/products, /purchases/nfe|cte|notes*, POST /stock/movements).','empresa','operar',['CL','CO']],
  ['pdv.supervise','PDV','/sistema/conferencia-maquininha','Conferência do PDV','Cobranças sem resposta, pendências, tratativa, vincular venda, estorno manual, Pix pendente (/core/pdv/terminal/uncertain|pendencias|reconcile…, /pdv/pix-pendentes).','empresa','gerir',['L','O']],
  ['pdv.terminal.activation','PDV','/sistema/configuracoes/maquininhas','Ligar/desligar maquininha por caixa','Liga e desliga a configuração de maquininha do PDV (GET/POST /core/pdv/terminal/configurations*).','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- VENDAS
  ['sales.view','Vendas','/sistema/vendas, /sistema/caixa','Vendas (ver)','Lista e detalhe de vendas, caixas e gavetas, devoluções, orçamentos, consignações, status fiscal da venda (leituras do escritório).','empresa','ler',['E','L','O','T']],
  ['sales.supervise','Vendas','/sistema/vendas','Supervisão de vendas','Expirar pré-vendas vencidas, descartar venda offline, confirmar pagamento pendente (POST /quotes/expire-overdue, /offline-sales/:id/discard, /sales/:id/payments/:id/confirmar).','empresa','gerir',['L','O']],
  ['sales.quotes.manage','Vendas','/sistema/orcamentos','Orçamentos e pré-vendas','Criar, editar, promover a pré-venda, renovar, reservar unidades (POST/PATCH /core/quotes*). Converter/cancelar exige também pdv.cash.operate.','empresa','operar',['C','CL','CO','L','O','T']],
  ['sales.consignment.manage','Vendas','/sistema/consignacoes','Consignação (condicional)','Criar consignação e registrar retorno (POST /core/consignments, /retorno). Faturar/fechar exige também pdv.cash.operate.','empresa','operar',['C','CL','CO','L','O','T']],
  ['sales.returns.operate','Vendas','/sistema/vendas/devolucoes','Cancelar e devolver venda','Pedir cancelamento ou devolução (POST /core/sales/:id/cancel, /core/sale-returns); sem a alçada correspondente, a rota pede a liberação de um gestor.','empresa','operar',['E','L','O','T']],
  ['sales.cancel.direct','Vendas','/sistema/vendas/devolucoes','Cancelar venda sem liberação','Cancela direto, sem pedir senha de gestor (comLiberacaoPontual de POST /core/sales/:id/cancel).','empresa','gerir',['L']],
  ['settings.sale_policy.manage','Configurações','/sistema/configuracoes/politica-de-venda','Política do balcão','Limite de desconto, prazo do fiado, validade da pré-venda, teto de sangria (GET/PUT /core/sale-policies).','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- ALÇADA
  ['approval.discount','Alçada','Diálogo "Chamar gestor"','Liberar desconto acima do limite','Autoriza com a própria senha o desconto de outro operador, e dá desconto acima do limite sem pedir (desconto_acima_limite).','empresa','gerir',['L','O']],
  ['approval.cash_withdrawal','Alçada','Diálogo "Chamar gestor"','Liberar sangria especial','Autoriza sangria acima do teto e faz sangria acima do teto sem pedir (sangria_especial).','empresa','gerir',['L','O']],
  ['approval.cash_reopen','Alçada','Diálogo "Chamar gestor"','Liberar reabertura de caixa','Autoriza reabrir turno fechado e reabre sem pedir (reabrir_caixa).','empresa','gerir',['L','O']],
  ['approval.sale_cancel','Alçada','Diálogo "Chamar gestor"','Liberar cancelamento de venda','Autoriza o cancelamento de UMA venda de outro operador (cancelar_venda, bilhete preso à venda).','empresa','gerir',['L','O']],
  ['approval.sale_return','Alçada','Diálogo "Chamar gestor"','Liberar devolução de venda','Autoriza a devolução de UMA venda de outro operador e devolve sem pedir (devolver_venda).','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- CLIENTES
  ['customers.view','Clientes','/sistema/clientes','Clientes (ver)','Lista e ficha de clientes, créditos do cliente.','empresa','ler',['E','L','O','T']],
  ['customers.manage','Clientes','/sistema/clientes','Clientes (cadastrar/editar)','POST/PUT /core/customers.','empresa','operar',['CL','CO','L','O','T']],
  ['customers.contact.view','Clientes','/sistema/clientes','Contato completo do cliente','Telefone, e-mail e documento inteiros; sem ela a projeção é mínima (alcanceDoCliente).','empresa','ler',['C','CL','CO','L','O','T']],
  ['customers.privacy.manage','Clientes','/sistema/clientes','LGPD do titular','Dados do titular, anonimizar, política de retenção (POST /customers/:id/anonimizar, GET /dados-do-titular, GET /lgpd/retencao).','empresa','gerir',['L','O']],
  ['customers.portal.invite','Clientes','/sistema/clientes, OS','Convidar para o portal','Enviar convite do portal do cliente (POST /core/customers/:id/convite-portal).','empresa','operar',['L','M','O','T']],

  // ---------------------------------------------------------------- PRODUTOS
  ['products.view','Produtos','/sistema/produtos','Produtos (ver)','Catálogo, categorias, marcas, auxiliares, imagens, histórico, promoções e cupons (leitura).','empresa','ler',['E','L','O','T']],
  ['products.manage','Produtos','/sistema/produtos','Produtos (cadastrar/editar)','Cadastro e edição de produto, códigos de barras, imagens, kit, variações, auxiliares, importação de planilha, fotos em lote, arquivo da balança.','empresa','gerir',['E','L','O']],
  ['products.price.manage','Produtos','/sistema/produtos/auxiliares','Preços e tabelas de preço','Tabelas de preço, faixas por quantidade, tabela do cliente, reprecificação da nota (/catalog/price-tables*, /products/:id/price-tiers, /purchases/repricing/apply).','empresa','gerir',['L','O']],
  ['products.catalog.admin','Produtos','/sistema/produtos/categorias','Catálogo (excluir/mesclar, confirmar importação)','Excluir e mesclar categorias e marcas, confirmar lote de importação de planilha.','empresa','gerir',['L','O']],
  ['labels.products.print','Produtos','/sistema/etiquetas','Etiquetas de produto','Imprimir e reimprimir etiquetas de produto (POST /labels/products, /labels/sheet). Gerar ou gravar código de barras no cadastro — inclusive pela folha — exige products.manage (POST /products/:id/barcode).','empresa','operar',['CL','E','L','O']],
  ['labels.equipment.print','Oficina','/sistema/etiquetas','Etiquetas de equipamento (folha)','Formatos e folha de etiquetas de equipamento (GET /labels/equipment/formats, POST /labels/equipment/sheet).','empresa','operar',['E','L','M','O','T']],
  ['workshop.equipment.label','Oficina','/sistema/oficina/os/:id','Etiqueta do equipamento da OS','Imprimir a etiqueta de um equipamento a partir da OS (POST /labels/equipment).','bancada','operar',['CO','M','O']],

  // ---------------------------------------------------------------- ESTOQUE
  ['inventory.view','Estoque','/sistema/estoque','Estoque (ver)','Posição, valorização, conferência, lotes e validade, saldos por local.','empresa','ler',['E','L','O','T']],
  ['inventory.manage','Estoque','/sistema/estoque/*','Estoque (movimentar)','Movimentar, lotes, locais, transferências, contagem de inventário.','empresa','gerir',['E','L','O']],
  ['inventory.adjust.approve','Estoque','/sistema/estoque/inventario','Aplicar ajuste de inventário','Aplicar e cancelar contagem, liberar reserva sem origem.','empresa','gerir',['L','O']],
  ['inventory.cost.view','Estoque','/sistema/estoque','Custo do estoque','Ver custo e valorização mesmo com a política de gestão desligada (veCustoDoEstoque).','empresa','ler',['L','O']],
  ['inventory.units.view','Estoque','/sistema/estoque/unidades','Unidades serializadas (PJ Motors: chassi)','Resumo e busca de unidades por número de série/chassi.','empresa','ler',['E','L','O','T']],
  ['inventory.units.manage','Estoque','/sistema/estoque/unidades','Unidades serializadas (editar, baixar, ligar equipamento)','PATCH/write-off de unidade, ligar a unidade a equipamento com plaquinha (/units/:id*).','empresa','gerir',['E','L','O']],

  // ---------------------------------------------------------------- COMPRAS
  ['purchases.view','Compras','/sistema/compras/*','Compras (ver)','Pedidos de compra, fornecedores, transportadoras, DF-e, devoluções, caixa de e-mail de NF-e, configuração da entrada (leitura).','empresa','ler',['E','L','O']],
  ['purchases.receive','Compras','/sistema/compras/entrada-notas','Entrada de notas','Importar XML/DF-e, conferir, vincular e confirmar a nota, amarrar a pedido, entrada manual.','empresa','operar',['E','L','O']],
  ['purchases.manage','Compras','/sistema/compras/*','Compras (gerir)','Pedidos de compra, fornecedores, transportadoras, manifestação, conta a pagar da nota, estorno, devolução ao fornecedor, caixa de e-mail.','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- FINANCEIRO
  ['finance.view','Financeiro','/sistema/financeiro','Financeiro (ver)','Lançamentos, contas a pagar/receber, DRE, categorias, centros de custo, cobranças do título.','empresa','ler',['E','L','O','T']],
  ['finance.advanced.view','Financeiro','/sistema/financeiro/fluxo-de-caixa','Fluxo de caixa e saldos','Fluxo de caixa projetado, saldos das contas, passivo de crédito de cliente, baixas legadas.','empresa','ler',['L','O']],
  ['finance.manage','Financeiro','/sistema/financeiro','Financeiro (lançar e baixar)','Lançar, baixar, estornar, estornar cobrança, contas bancárias, categorias e centros de custo.','empresa','gerir',['L','O']],
  ['finance.commissions.manage','Financeiro','/sistema/financeiro/comissoes','Comissões','Grupos, faixas e apuração de comissão por vendedor.','empresa','gerir',['L','O']],
  ['finance.acquirers.manage','Financeiro','/sistema/financeiro/operadoras','Operadoras de cartão','Taxas e prazos das operadoras.','empresa','gerir',['L','O']],
  ['finance.bank_reconciliation.manage','Financeiro','/sistema/financeiro/conciliacao','Conciliação bancária','Extrato do banco × financeiro.','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- RELATÓRIOS
  ['reports.central.view','Relatórios','/sistema/relatorios/central','Central de relatórios','Relatórios que juntam custo, comissão e margem (GET /core/reports*).','empresa','ler',['L','O']],
  ['reports.bi.view','Relatórios','/sistema/relatorios/bi','BI','Comparativos por operação, produto, marca e margem (GET /core/insights/*). Compara só empresas em que a pessoa também tem esta capability.','empresa','ler',['L','O']],

  // ---------------------------------------------------------------- FISCAL
  ['fiscal.view','Fiscal','/sistema/fiscal/*','Fiscal (ver)','Configuração, prontidão, fila, séries, inutilizações, contingência, conciliação, XML, NFS-e (leitura).','empresa','ler',['L','O']],
  ['fiscal.manage','Fiscal','/sistema/fiscal/documentos','Fiscal (operar documentos)','Transmitir, reenfileirar, drenar fila, entrar/sair de contingência, reler notas para classificação.','empresa','gerir',['L','O']],
  ['fiscal.config.manage','Fiscal','/sistema/fiscal/configuracao','Configuração fiscal','Dados fiscais da empresa, séries, configuração de NFS-e.','empresa','gerir',['L','O']],
  ['fiscal.csc.manage','Fiscal','/sistema/fiscal/configuracao','CSC da NFC-e','Ver e gravar o CSC (GET/POST /core/fiscal/nfce/csc).','empresa','gerir',['L']],
  ['fiscal.documents.cancel','Fiscal','/sistema/fiscal/documentos','Cancelar nota, CC-e e inutilizar','Cancelar documento, carta de correção, inutilizar numeração, registrar cancelamento de NFS-e.','empresa','gerir',['L','O']],
  ['fiscal.sale.emit','Fiscal','/pdv, /sistema/fiscal/documentos','Emitir a nota da venda','Emitir NFC-e/NF-e/NFS-e da venda, ver DANFE/DANFCE e o resumo fiscal do PDV.','empresa','operar',['C','CL','CO','L','O']],
  ['fiscal.products.classify','Fiscal','/sistema/fiscal/configuracao','Classificação fiscal de produtos','Pendências fiscais de produto e confirmação de classificação.','empresa','operar',['E','L','O']],

  // ---------------------------------------------------------------- CONTABILIDADE
  ['accounting.closing.view','Contabilidade','/sistema/fiscal/fechamento','Fechamento do mês (ver e baixar)','Prévia, conferência e pacote do mês com os XML (GET /core/fiscal/closings/*). É o que o contador recebe.','empresa','ler',['K','L','O']],
  ['accounting.closing.send','Contabilidade','/sistema/fiscal/fechamento','Enviar ao contador','Enviar o pacote, destinatários e agenda do envio.','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- OFICINA
  ['workshop.kanban.view','Oficina','/sistema/oficina','Oficina: ver kanban e OS','Kanban, OS, avisos, checklist, fotos e impressão da OS. Mecânico: só nas bancadas em que é membro.','bancada','ler',TODOS],
  ['workshop.orders.open','Oficina','/sistema/oficina','Abrir OS e atender','Abrir OS, cadastrar equipamento, comentar, fotos, checklist (POST /core/workshop/orders, /equipment, /comments, /photos, /checklist).','bancada','operar',['CO','M','O','T']],
  ['workshop.orders.move','Oficina','/sistema/oficina','Mover OS no kanban','POST /core/workshop/orders/:id/move.','bancada','operar',['CO','M','O']],
  ['workshop.orders.assume','Oficina','/sistema/oficina/os/:id','Assumir e liberar OS','POST /core/workshop/orders/:id/assume e /release.','bancada','operar',['M','O']],
  ['workshop.orders.plan','Oficina','/sistema/oficina/os/:id','Planejar OS','Plano de serviço e remoção de foto (PATCH /plan, DELETE /photos/:id).','bancada','operar',['M','O']],
  ['workshop.parts.use','Oficina','/sistema/oficina/os/:id','Peças na OS','Lançar e devolver peça na OS.','bancada','operar',['M','O']],
  ['workshop.labor.manage','Oficina','/sistema/oficina/os/:id','Mão de obra na OS','POST /core/workshop/orders/:id/labor.','bancada','operar',['M','O']],
  ['workshop.orders.complete','Oficina','/sistema/oficina/os/:id','Concluir OS','POST /core/workshop/orders/:id/complete.','bancada','operar',['M','O']],
  ['workshop.quote.request','Oficina','/sistema/oficina/os/:id','Orçamento da OS','Pedir aprovação e registrar a decisão do cliente.','bancada','operar',['M','O','T']],
  ['workshop.checkout','Oficina','/sistema/oficina, /pdv','Checkout da OS','Cobrar a OS pronta, fila de pagamento, pedir estorno (POST /checkout, GET /pending-payment, POST /estorno).','bancada','operar',['CO','O']],
  ['workshop.checkout.refund','Oficina','/sistema/oficina','Estornar OS sem liberação','Estorno direto do pagamento da OS, sem pedir senha de gestor (comLiberacaoPontual de /estorno).','bancada','gerir',['O']],
  ['workshop.admin','Oficina','/sistema/oficina','Gerência da oficina','SLA, regularizar OS, desfazer troca de dono do equipamento.','bancada','gerir',['O']],
  ['workshop.tickets.manage','Oficina','/sistema/oficina','Chamados','Chamados abertos pelo cliente: ver, converter em OS, encerrar.','bancada','operar',['L','M','O','T']],
  ['workshop.parts.view','Oficina','/sistema/oficina/pecas','Peças (ver)','Estoque da bancada e movimentações de peça.','bancada','ler',['E','L','M','O','T']],
  ['workshop.parts.manage','Oficina','/sistema/oficina/pecas','Peças (cadastrar, repor)','POST/PATCH /core/workshop/parts, reposição.','bancada','gerir',['E','L','O']],
  ['workshop.parts.cost.view','Oficina','/sistema/oficina/pecas','Custo da peça','Sem ela o custo não sai do servidor (podeVerCusto).','bancada','ler',['E','L','O']],
  ['workshop.equipment.view','Oficina','/sistema/equipamentos','Equipamentos (ver)','Lista e ficha de equipamento, fotos.','bancada','ler',TODOS],
  ['workshop.equipment.manage','Oficina','/sistema/equipamentos/:id','Equipamentos (editar)','Editar ficha e identidade, remover foto, trocar plaquinha.','bancada','operar',['M','O']],
  ['workshop.equipment.owner','Oficina','/sistema/equipamentos/:id','Dono do equipamento','Registrar o comprador como dono (PJ Motors vende a moto).','empresa','operar',['CL','L','O']],
  ['workshop.tags.view','Oficina','/sistema/equipamentos/plaquinhas','Plaquinhas (ver)','Pool e lotes de plaquinhas.','empresa','ler',['CO','E','L','M','O','T']],
  ['workshop.tags.print','Oficina','/sistema/equipamentos/plaquinhas','Plaquinhas (gerar e imprimir)','Gerar lote, folha, avaria.','empresa','operar',['E','L','M','O']],
  ['workshop.tags.release','Oficina','/sistema/equipamentos/plaquinhas','Plaquinhas (liberar para uso)','POST /core/equipment-tags/release.','empresa','gerir',['E','L','O']],
  ['workshop.tags.layout','Oficina','/sistema/equipamentos/plaquinhas','Plaquinhas (layout)','PUT /core/equipment-tags/layout.','empresa','gerir',['L','O']],
  ['workshop.benches.view','Oficina','/sistema/oficina/oficinas','Oficinas e bancadas (ver)','GET /core/workshops, /workshops/brands.','empresa','ler',['E','L','O','T']],
  ['workshop.benches.manage','Oficina','/sistema/oficina/oficinas','Oficinas e bancadas (membros, marca)','Quem trabalha em cada bancada e quem assina o papel.','empresa','gerir',['L','O']],

  // ---------------------------------------------------------------- LOCAÇÃO / CRM
  ['rentals.view','Locação','/sistema/locacao/contratos','Locação (ver)','Contratos de locação.','empresa','ler',['CL','L','O','T']],
  ['rentals.manage','Locação','/sistema/locacao/contratos','Locação (contratar, devolver)','POST /rentals, /rentals/:id/return.','empresa','operar',['L','O','T']],
  ['rentals.cancel','Locação','/sistema/locacao/contratos','Cancelar locação','POST /rentals/:id/cancel.','empresa','gerir',['L','O']],
  ['crm.view','CRM','/sistema/crm/*','CRM (ver)','Leads, oportunidades, resumo, programa de fidelidade.','empresa','ler',['CL','L','O','T']],
  ['crm.leads.manage','CRM','/sistema/crm/leads','Leads e oportunidades','Registrar lead, mudar status, abrir oportunidade.','empresa','operar',['CL','L','O','T']],
  ['crm.opportunities.close','CRM','/sistema/crm/leads','Converter lead e fechar oportunidade','POST /leads/:id/convert, /opportunities/:id/close.','empresa','operar',['L','O','T']],
  ['crm.loyalty.config','CRM','/sistema/crm/fidelidade','Programa de fidelidade','PUT /core/loyalty/program.','empresa','gerir',['L','O']],
  ['crm.loyalty.redeem','CRM','/pdv, /sistema/crm/fidelidade','Resgatar pontos','POST /core/loyalty/redeem.','empresa','operar',['CL','L','O']],

  // ---------------------------------------------------------------- E-COMMERCE / LOGÍSTICA
  ['ecommerce.orders.view','E-commerce','/sistema/pedidos','Pedidos online (ver)','GET /core/orders*.','empresa','ler',['E','L','O','T']],
  ['ecommerce.orders.fulfill','E-commerce','/sistema/pedidos','Separar e expedir pedido','POST /core/orders/:id/fulfillment.','empresa','operar',['E','L','T']],
  ['ecommerce.orders.service','E-commerce','/sistema/pedidos','Atender pedido (cancelar, decidir devolução)','POST /orders/:id/cancel, /devolucao/solicitacoes/:id/decidir.','empresa','operar',['L','T']],
  ['ecommerce.orders.receive_return','E-commerce','/sistema/pedidos','Receber devolução do pedido','POST /orders/:id/devolucao/receber.','empresa','operar',['E','L']],
  ['ecommerce.orders.manage','E-commerce','/sistema/pedidos','Pedidos online (gerir)','Pagar, devolver, voltar a expedição, NF-e do pedido.','empresa','gerir',['L']],
  ['ecommerce.store.manage','E-commerce','/sistema/loja/*','Administração da loja','Vitrine, imagens, destaques, política de checkout, prontidão do dia 1.','empresa','gerir',['L','O']],
  ['ecommerce.shipping.manage','E-commerce','/sistema/loja/entrega','Entrega da loja','Se a loja entrega e por quanto (GET/PUT /core/shipping-settings).','empresa','gerir',['L','O']],
  ['ecommerce.emails.manage','E-commerce','/sistema/loja/emails','E-mails da loja','Fila, reenvio, envio e identidade de e-mail; prontidão de comunicações.','empresa','gerir',['L','O']],
  ['ecommerce.publish','E-commerce','/sistema/produtos/prontidao-online','Publicar produtos prontos','POST /core/products/publicar-prontos.','empresa','gerir',['L']],
  ['ecommerce.promotions.manage','E-commerce','/sistema/promocoes, /sistema/cupons','Promoções e cupons','Criar, editar e excluir promoção e cupom.','empresa','gerir',['L']],
  ['logistics.view','Logística','/sistema/loja/logistica','Logística (ver)','Envios, etiquetas, rastreio, transportadoras (leitura) — módulo logistics.','empresa','ler',['E','L','T']],
  ['logistics.manage','Logística','/sistema/loja/logistica','Logística (cotar, etiquetar)','Cotar frete, gerar etiqueta, cancelar envio, credencial de transportadora, homologação.','empresa','gerir',['E','L']],

  // ---------------------------------------------------------------- INTEGRAÇÕES / CONFIGURAÇÕES
  ['integrations.status.view','Integrações','/sistema/integracoes','Integrações (estado)','GET /core/integrations/status.','empresa','ler',['L','O']],
  ['integrations.asaas.view','Integrações','/sistema/integracoes/asaas','Asaas (ver)','Estado da conexão, cobranças e fila (módulo asaas, leitura).','empresa','ler',['L','T']],
  ['integrations.asaas.manage','Integrações','/sistema/integracoes/asaas','Asaas (credencial, homologar, produção)','Credenciais, webhook, homologação, ativar produção, cobrar e cancelar cobrança.','empresa','gerir',['L']],
  ['integrations.asaas.reconcile','Integrações','/sistema/integracoes/asaas/conciliacao','Conciliação Asaas','Extrato do provedor × financeiro.','empresa','gerir',['L','O']],
  ['integrations.card_terminal.view','Integrações','/sistema/configuracoes/maquininhas','Maquininha (ver)','Provedores, configurações, terminais, transações e comprovantes (módulo payment-terminal, leitura).','empresa','ler',['C','CL','CO','L','T']],
  ['integrations.card_terminal.operate','Integrações','/pdv','Maquininha (operar)','Transação, cancelamento, estorno, reimpressão, recuperação (módulo payment-terminal, escrita).','empresa','operar',['C','CL','CO','L']],
  ['integrations.card_terminal.manage','Integrações','/sistema/configuracoes/maquininhas','Maquininha (configurar)','Cadastrar, credencial, parear e revogar agente, homologar, consultar desfecho.','empresa','gerir',['L']],
  ['integrations.sync.operate','Integrações','/sistema/integracoes/central','Banco central (sincronizar)','Estado e rodada da sincronização com a central.','empresa','operar',['L','O']],
  ['integrations.sync.admin','Integrações','/sistema/integracoes/central','Banco central (carga, sonda, reviver)','POST /core/sync/probe|bootstrap|revive; conferir esquema.','empresa','gerir',['L']],
  ['settings.printers.view','Configurações','/sistema/configuracoes/impressoras','Impressoras (ver)','GET /core/print/printers, /print/readiness.','empresa','ler',['E','L','O','T']],
  ['settings.printers.manage','Configurações','/sistema/configuracoes/impressoras','Impressoras (cadastrar, testar)','POST /core/print/printers, /test.','empresa','gerir',['L','O']],
  ['settings.terminals.manage','Configurações','/sistema/configuracoes/terminais','Caixas e terminais','Cadastrar, editar, ativar e desativar caixa (PDV/local).','empresa','gerir',['L','O']],
];

const any = (...c) => ['any', ...c];
const all = (...c) => ['all', ...c];
const PUB = 'PUBLICA';
// [expr, file, methodRegex, pathRegex]
const R = [];
const r = (e, m, p, f = 'core.ts') => R.push([e, f, new RegExp('^(?:' + m + ')$'), new RegExp('^(?:' + p + ')$')]);
const G = 'GET', P = 'POST|PUT|PATCH|DELETE', X = 'GET|POST|PUT|PATCH|DELETE';
const BAL_ESC = any('pdv.sell', 'sales.view');
const TODOS_AMB = any('pdv.sell', 'sales.view', 'workshop.kanban.view');

// públicas ficam públicas
// core.ts
r('finance.acquirers.manage', X, '/acquirers.*');
r('integrations.asaas.reconcile', X, '/asaas/conciliacao.*');
r('audit.view', G, '/audit');
r(BAL_ESC, 'POST', '/authorizations');
r(BAL_ESC, G, '/authorizations/quem-libera');
r('audit.view', G, '/authorizations');
r('finance.bank_reconciliation.manage', X, '/bank/.*');
r('purchases.view', G, '/carriers(/:id)?');
r('purchases.manage', P, '/carriers.*');
r('pdv.cash.operate', 'POST', '/cash/open|/cash/:sessionId/(movements|close|reopen)');
r(any('pdv.cash.operate', 'sales.view'), G, '/cash/.*');
r('products.view', G, '/catalog/(aux|custom-fields|tax-groups|price-tables/:id/items)');
r('products.view', 'POST', '/catalog/pricing/preview');
r('products.price.manage', P, '/catalog/price-tables.*');
r('products.manage', P, '/catalog/(custom-fields|tax-groups|tax-rates|units).*');
r('finance.commissions.manage', X, '/commissions.*');
r('group.companies.manage', X, '/companies.*');
r('ecommerce.emails.manage', X, '/comunicacoes/prontidao');
r(any('sales.consignment.manage', 'sales.view'), G, '/consignments.*');
r(all('sales.consignment.manage', 'pdv.cash.operate'), 'POST', '/consignments/:id/(faturar|fechar)');
r('sales.consignment.manage', 'POST', '/consignments(/:id/retorno)?');
r('products.view', G, '/coupons');
r('ecommerce.promotions.manage', P, '/coupons.*');
r('crm.view', G, '/crm/summary');
r('finance.advanced.view', G, '/customer-credits/liability');
r(any('customers.view', 'pdv.sell', 'workshop.orders.open'), G, '/customers(/:id)?');
r('customers.manage', 'POST|PUT', '/customers(/:id)?');
r('customers.privacy.manage', X, '/customers/:id/(anonimizar|dados-do-titular)');
r('customers.portal.invite', 'POST', '/customers/:id/convite-portal');
r(any('customers.view', 'pdv.sell'), G, '/customers/:id/credits');
r('products.price.manage', 'PUT', '/customers/:id/price-table');
r('dashboard.view', G, '/dashboard');
r('ecommerce.emails.manage', X, '/emails.*');
r('workshop.tags.view', G, '/equipment-tags(/batches)?');
r('workshop.tags.layout', 'PUT', '/equipment-tags/layout');
r('workshop.tags.print', X, '/equipment-tags/(:id/damage|batches|layout|sheet)');
r('workshop.equipment.manage', 'POST', '/equipment-tags/:id/replace');
r('workshop.tags.release', 'POST', '/equipment-tags/release');
r('workshop.equipment.view', G, '/equipment(/:id(/photos)?)?');
r('workshop.orders.open', 'POST', '/equipment(/:id/photos)?');
r('workshop.equipment.manage', 'PATCH|DELETE', '/equipment/:id(/identidade|/photos/:photoId)?');
r('workshop.admin', 'POST', '/equipment/:id/owner/desfazer');
r('workshop.equipment.owner', 'POST', '/equipment/:id/owner');
r('finance.advanced.view', G, '/finance/(cash-flow|legacy-settlements|setup)');
r('finance.view', G, '/finance/.*');
r(any('finance.manage', 'pdv.cash.operate'), 'POST', '/finance/entries/:id/(charge|charges/cancel|settle)');
r('finance.manage', P, '/finance/.*');
// fiscal
r('group.dashboard.view', G, '/fiscal/certificates/group');
r('fiscal.certificate.manage', X, '/fiscal/certificate.*');
r('fiscal.policy.manage', 'PUT', '/fiscal/(acts|contingency)/policy|/fiscal/emission-policy');
r('fiscal.policy.manage', 'POST', '/fiscal/production-unlock');
r('fiscal.products.classify', X, '/fiscal/classification(/confirm)?|/fiscal/product-pendencies.*');
r('fiscal.manage', 'POST', '/fiscal/classification/reler-notas');
r('accounting.closing.send', X, '/fiscal/closings/:period/(enviar|envios)|/fiscal/contador/.*');
r('accounting.closing.view', G, '/fiscal/closings/.*');
r('fiscal.config.manage', 'PATCH', '/fiscal/config');
r('fiscal.config.manage', 'POST', '/fiscal/series');
r('fiscal.manage', 'POST', '/fiscal/contingency/(enter|exit)|/fiscal/documents/:id/(reenfileirar|transmitir)|/fiscal/queue/drain');
r('fiscal.documents.cancel', 'POST', '/fiscal/documents/:id/(cancel|correction-letter)|/fiscal/void-ranges');
r('fiscal.csc.manage', X, '/fiscal/nfce/csc');
r('fiscal.view', G, '/fiscal/documents/:id/xml');
r(any('fiscal.sale.emit', 'fiscal.view'), G, '/fiscal/documents(/:id(/danfce|/danfe)?)?|/fiscal/pdv-summary');
r(any('fiscal.sale.emit', 'sales.view'), G, '/fiscal/sales/:saleId/status');
r('fiscal.sale.emit', X, '/fiscal/sales/:saleId/(emission-readiness|emit)');
r('fiscal.view', G, '/fiscal/.*');
r('fiscal.view', 'POST', '/fiscal/sefaz/status');
r('products.catalog.admin', 'POST', '/import/produtos/:id/confirmar');
r('products.manage', X, '/import/produtos.*');
r('purchases.view', G, '/inbound/config');
r('purchases.manage', 'PUT', '/inbound/config');
r('reports.bi.view', G, '/insights/.*');
r('group.dashboard.view', G, '/integrations/asaas/grupo');
r('integrations.asaas.manage', X, '/integrations/asaas.*');
r('integrations.status.view', G, '/integrations/status');
r('inventory.adjust.approve', 'POST', '/inventory-counts/:id/(apply|cancel)');
r('inventory.manage', X, '/inventory-counts.*');
r('products.view', X, '/labels/candidates(/codes)?');
r(any('pdv.sell', 'products.view', 'workshop.kanban.view'), G, '/labels/catalog');
r('workshop.equipment.label', 'POST', '/labels/equipment');
r('labels.equipment.print', X, '/labels/equipment/(formats|sheet)');
r('labels.products.print', 'POST', '/labels/(products|sheet)');
r('crm.view', G, '/leads|/opportunities');
r('crm.opportunities.close', 'POST', '/leads/:id/convert|/opportunities/:id/close');
r('crm.leads.manage', P, '/leads.*|/opportunities');
r('customers.privacy.manage', G, '/lgpd/retencao');
r('logistics.manage', X, '/logistics/.*');
r('ecommerce.store.manage', G, '/loja/prontidao-do-dia-1');
r('crm.view', G, '/loyalty/.*');
r('crm.loyalty.config', 'PUT', '/loyalty/program');
r('crm.loyalty.redeem', 'POST', '/loyalty/redeem');
r('purchases.view', G, '/mail/.*');
r('purchases.view', 'POST', '/mail/check');
r('purchases.manage', P, '/mail/.*');
r(any('dashboard.view', 'settings.management_policy.manage'), G, '/management-policy');
r('settings.management_policy.manage', 'PUT', '/management-policy');
r(BAL_ESC, G, '/offline-sales');
r('sales.supervise', 'POST', '/offline-sales/:id/discard');
r('pdv.sell', 'POST', '/offline-sales(/:id/(relaunch|relaunch-as-new))?');
r('ecommerce.orders.view', G, '/orders(/:id)?');
r('ecommerce.orders.service', 'POST', '/orders/:id/(cancel|devolucao/solicitacoes/:requestId/decidir)');
r('ecommerce.orders.receive_return', 'POST', '/orders/:id/devolucao/receber');
r('ecommerce.orders.fulfill', 'POST', '/orders/:id/fulfillment');
r('ecommerce.orders.manage', X, '/orders/:id/.*');
r('finance.view', G, '/payment-intents');
r(any('finance.manage', 'pdv.cash.operate'), 'POST', '/payment-intents/:id/retry');
r(TODOS_AMB, G, '/payment-methods');
r('pdv.supervise', G, '/pdv/pix-pendentes');
r(BAL_ESC, G, '/pdv/pix-asaas.*');
r('pdv.sell', 'POST', '/pdv/pix-asaas(/:id/cancel)?');
r('pdv.terminal.activation', X, '/pdv/terminal/configurations.*');
r('pdv.supervise', X, '/pdv/terminal/(pendencias|uncertain|:id/(estorno-manual|reconcile|tratativa|vincular-venda))');
r(any('pdv.payment.charge', 'sales.view'), G, '/pdv/terminal/(:id|status)');
r('pdv.payment.charge', 'POST', '/pdv/terminal/(charge|:id/(confirmar-teste|desistir))');
r('integrations.google_login.manage', X, '/portal/login-google');
r(TODOS_AMB, 'POST', '/pricing/cart');
r(any('pdv.cash.operate', 'sales.view'), G, '/print/drawer');
r('pdv.cash.operate', 'POST', '/print/drawer/open');
r('settings.printers.view', G, '/print/(printers|readiness)');
r('settings.printers.manage', 'POST', '/print/printers(/:id/test)?');
// Reimprimir: CL, CO, L, O, T hoje. pdv.sell reproduz, e alarga só para o legado operador_caixa (0 vínculos).
r('pdv.sell', 'POST', '/print/jobs/:id/reprint');
r(BAL_ESC, X, '/print/jobs.*');
r('products.view', G, '/products');
r(any('products.manage', 'pdv.backoffice'), 'POST', '/products');
r(any('products.view', 'pdv.sell'), G, '/products/(:id|search|:id/price-tiers)');
r('labels.products.print', 'POST', '/products/:id/barcode');
r(any('products.manage', 'pdv.backoffice'), 'PUT', '/products/:id/custom-fields');
r('products.price.manage', P, '/products/:id/price-tiers.*');
r('ecommerce.publish', 'POST', '/products/publicar-prontos');
r('products.manage', G, '/products/prontidao-online');
r('products.view', G, '/products/:id/.*');
r('products.manage', P, '/products.*');
r('products.view', G, '/promotions');
r('ecommerce.promotions.manage', P, '/promotions.*');
r('purchases.view', G, '/purchase-orders.*');
r('purchases.receive', 'POST', '/purchase-orders/:id/notes/:noteId');
r('purchases.manage', P, '/purchase-orders.*');
r(any('purchases.receive', 'pdv.backoffice', 'accounting.closing.view'), G, '/purchases/notes/:id/xml');
r('purchases.view', G, '/purchases/(dfe|notes/:id/(devolviveis|repricing)|supplier-returns.*)');
r('purchases.manage', X, '/purchases/(dfe/:chave/manifestar|notas-sem-conta|notes/:id/(conta-a-pagar|estornar)|supplier-returns.*)');
r('products.price.manage', 'POST', '/purchases/repricing/apply');
r(any('purchases.receive', 'pdv.backoffice'), X, '/purchases/(cte|cte/import|nfe/import|nfe/preview|notes|notes/:id/(conferir|confirm|items|link))');
r('purchases.receive', X, '/purchases/(dfe/:chave/importar|dfe/consultar|manual)');
r(any('sales.quotes.manage', 'sales.view'), G, '/quotes.*');
r('sales.supervise', 'POST', '/quotes/expire-overdue');
r(all('sales.quotes.manage', 'pdv.cash.operate'), 'POST', '/quotes/:id/(cancel|convert)');
r('sales.quotes.manage', P, '/quotes.*');
r('rentals.view', G, '/rentals.*');
r('rentals.cancel', 'POST', '/rentals/:id/cancel');
r('rentals.manage', 'POST', '/rentals(/:id/return)?');
r('reports.central.view', G, '/reports.*');
r('settings.sale_policy.manage', X, '/sale-policies');
r(BAL_ESC, G, '/sale-returns.*');
r('sales.returns.operate', 'POST', '/sale-returns|/sales/:id/cancel');
r('pdv.sell', 'POST', '/sales');
r('sales.supervise', 'POST', '/sales/:id/payments/:paymentId/confirmar');
r(BAL_ESC, G, '/sales.*');
r('products.manage', 'POST', '/scales/export');
r(TODOS_AMB, G, '/scales/formats');
r('products.view', G, '/scales/products');
r('pdv.cash.operate', G, '/sellers');
r('ecommerce.shipping.manage', X, '/shipping-settings');
r(any('inventory.view', 'pdv.sell', 'workshop.kanban.view'), G, '/stock/locations');
r(any('inventory.view', 'workshop.parts.view'), G, '/stock/(movement-kinds|movements)');
r(any('inventory.manage', 'pdv.backoffice'), 'POST', '/stock/movements');
r('inventory.adjust.approve', 'POST', '/stock/reservations/:productId/liberar-sem-origem');
r('inventory.view', G, '/stock.*');
r('inventory.manage', P, '/stock.*');
r('ecommerce.store.manage', X, '/storefront/.*');
r('purchases.view', G, '/suppliers.*');
r('purchases.manage', P, '/suppliers.*');
r('integrations.sync.admin', 'POST', '/sync/(bootstrap|probe|revive)');
r('integrations.sync.operate', X, '/sync/(run|status)');
r('system.secrets.view', G, '/system/secrets-readiness');
r('products.view', G, '/taxonomy');
r('products.catalog.admin', 'DELETE|POST', '/taxonomy/(brands|categories)/(:id|merge)');
r('products.manage', 'POST', '/taxonomy/(brands|categories)');
r('users.password_recovery.manage', X, '/team/recuperacao-de-senha');
r('users.view', G, '/team(/profiles)?');
r('users.deactivate', 'POST', '/team/:id/active');
r('users.reset_password', 'POST', '/team/:id/password');
r('users.manage', P, '/team.*');
r(any('pdv.sell', 'sales.view', 'settings.terminals.manage'), G, '/terminals');
r('settings.terminals.manage', P, '/terminals.*');
r(any('inventory.units.view', 'pdv.sell'), G, '/units(/:productId)?');
r('inventory.units.view', G, '/units/summary');
r('inventory.units.manage', X, '/units.*');
r('workshop.tickets.manage', X, '/workshop/chamados.*');
r('workshop.orders.open', G, '/workshop/entrada');
r('workshop.kanban.view', G, '/workshop/orders(/:id(/avisos|/checklist|/impressao|/photos)?)?');
r('workshop.orders.open', 'POST|PATCH', '/workshop/orders(/:id/(checklist/:itemId|comments|photos))?');
r('workshop.orders.assume', 'POST', '/workshop/orders/:id/(assume|release)');
r('workshop.checkout', 'POST', '/workshop/orders/:id/(checkout|estorno)');
r('workshop.orders.complete', 'POST', '/workshop/orders/:id/complete');
r('workshop.quote.request', 'POST', '/workshop/orders/:id/(decidir-orcamento|pedir-aprovacao)');
r('workshop.labor.manage', 'POST', '/workshop/orders/:id/labor');
r('workshop.orders.move', 'POST', '/workshop/orders/:id/move');
r('workshop.parts.use', 'POST', '/workshop/orders/:id/parts|/workshop/orders/:orderId/parts/:partId/return');
r('workshop.orders.plan', 'PATCH|DELETE', '/workshop/orders/:id/(plan|photos/:photoId)');
r('workshop.admin', 'POST', '/workshop/orders/:id/regularizar');
r(any('workshop.parts.use', 'workshop.parts.manage'), G, '/workshop/parts/scan');
r('workshop.parts.view', G, '/workshop/parts');
r('workshop.parts.manage', P, '/workshop/parts.*');
r('workshop.checkout', G, '/workshop/pending-payment');
r('workshop.admin', X, '/workshop/sla');
r('workshop.benches.view', G, '/workshops(/brands)?');
r('workshop.benches.manage', X, '/workshops/.*');
// nfse.ts
r('fiscal.sale.emit', X, '/fiscal/sales/:saleId/nfse.*', 'nfse.ts');
r('fiscal.config.manage', 'PATCH', '/fiscal/nfse/config', 'nfse.ts');
r('fiscal.documents.cancel', 'POST', '/fiscal/nfse/:id/cancel-record', 'nfse.ts');
r('fiscal.view', G, '/fiscal/nfse/.*', 'nfse.ts');
// payment-terminals.ts
r('integrations.card_terminal.view', G, '/readiness|/providers-status|/providers.*|/configurations|/terminals|/transactions(/:id(/receipt)?)?|/dashboard', 'payment-terminals.ts');
r('integrations.card_terminal.manage', X, '/local-agent/(pairing|pair|heartbeat)|/local-agents/:id/revoke|/agent-commands|/configurations(/:id)?|/credentials|/providers/:provider/test-transaction|/transactions/:id/query|/homologation/run', 'payment-terminals.ts');
r('integrations.card_terminal.operate', X, '.*', 'payment-terminals.ts');
// logistics.ts
r('logistics.view', G, '/readiness|/providers-status|/shipments.*|/orders/:orderId/shipments|/settings/shipping|/carriers', 'logistics.ts');
// test-tracking é POST, mas a permissão de hoje é logistics.tracking.view (leitura): E, L e T.
r('logistics.view', 'POST', '/carriers/:carrier/test-tracking', 'logistics.ts');
r('logistics.manage', X, '.*', 'logistics.ts');
// system-admin.ts
r('system.status.view', G, '/readiness|/release', 'system-admin.ts');
r('system.deploy.view', G, '/implantacao.*', 'system-admin.ts');
r('system.deploy.manage', X, '/implantacao/.*', 'system-admin.ts');
r('system.backup.view', G, '/backup/status', 'system-admin.ts');
r('system.backup.manage', X, '/backup/.*', 'system-admin.ts');
// index.ts (asaas)
r('integrations.asaas.view', G, '/asaas/.*', 'index.ts');
r('integrations.asaas.manage', X, '/asaas/.*', 'index.ts');
// auth.ts
r('devices.view', G, '/devices', 'auth.ts');
r('devices.manage', 'POST', '/device/(enroll|:id/revoke)', 'auth.ts');

// ------------------------------------------------------------------ verificação
const capByCode = new Map(CAPS.map((c) => [c[0], c]));
const Pof = (code) => { const c = capByCode.get(code); if (!c) throw new Error('capability sem definição: ' + code); return new Set(c[7]); };
function acesso(expr) {
  if (typeof expr === 'string') return Pof(expr);
  const [op, ...cs] = expr; const sets = cs.map(Pof);
  if (op === 'any') return new Set(sets.flatMap((s) => [...s]));
  return new Set([...sets[0]].filter((x) => sets.every((s) => s.has(x))));
}
const txt = (e) => (typeof e === 'string' ? e : `${e[0] === 'any' ? 'qualquer' : 'todas'}(${e.slice(1).join(', ')})`);
const rows = JSON.parse(fs.readFileSync('_rotas-resolvidas.json', 'utf8'));
const out = []; const desvios = []; const semRegra = []; const uso = new Map();
for (const row of rows) {
  if (row.set === 'PUBLICA') { out.push([row.f, row.l, row.m, row.p, 'rotaPublica (inalterada)', 'PUBLICA', 'PUBLICA', 'igual']); continue; }
  const regra = R.find(([, f, m, p]) => f === row.f && m.test(row.m) && p.test(row.p));
  if (!regra) { semRegra.push(row); continue; }
  const e = regra[0];
  for (const c of (typeof e === 'string' ? [e] : e.slice(1))) uso.set(c, (uso.get(c) ?? 0) + 1);
  const hoje = new Set(row.set === 'DONOS' ? [] : row.set.split(','));
  const novo = acesso(e);
  const ganha = [...novo].filter((x) => !hoje.has(x)).sort();
  const perde = [...hoje].filter((x) => !novo.has(x)).sort();
  const veredito = !ganha.length && !perde.length ? 'igual' : `DESVIO ganha=[${ganha}] perde=[${perde}]`;
  if (veredito !== 'igual') desvios.push({ row, e: txt(e), ganha, perde });
  out.push([row.f, row.l, row.m, row.p, `${row.g}(${row.a})`, row.set, txt(e), veredito]);
}
fs.writeFileSync('mapa-rota-capability.tsv', 'arquivo\tlinha\tmetodo\tcaminho\tguarda_hoje\tperfis_hoje(+admin_geral,gestor)\trequireCapability\tequivalencia_dia1\n' + out.map((o) => o.join('\t')).join('\n') + '\n');
const catalogo = CAPS.map(([code, area, pagina, label, descricao, escopo, tipo, P]) => ({
  code, area, pagina, label, descricao, escopo, leitura_ou_escrita: tipo,
  perfis_de_hoje: ['admin_geral', 'gestor', ...P.map((x) => FULL[x])],
}));
fs.writeFileSync('_uso-por-capability.json', JSON.stringify(Object.fromEntries(uso), null, 2));
fs.writeFileSync('catalogo.json', JSON.stringify(catalogo, null, 2) + '\n');
// modelos semeados (dia 1)
const modelos = {};
for (const [ab, full] of Object.entries(FULL)) modelos[full] = CAPS.filter((c) => c[7].includes(ab)).map((c) => c[0]);
modelos.admin_geral = CAPS.map((c) => c[0]); modelos.gestor = CAPS.map((c) => c[0]);
fs.writeFileSync('_modelos-dia1.json', JSON.stringify(modelos, null, 2));
console.log('capabilities:', CAPS.length, '| rotas:', rows.length, '| sem regra:', semRegra.length, '| desvios:', desvios.length);
for (const s of semRegra) console.log('SEM REGRA', s.f, s.l, s.m, s.p, s.set);
for (const d of desvios) console.log('DESVIO', d.row.f + ':' + d.row.l, d.row.m, d.row.p, 'hoje=' + d.row.set, '->', d.e, 'ganha=' + d.ganha, 'perde=' + d.perde);
const naoUsadas = CAPS.filter((c) => !uso.has(c[0])).map((c) => c[0]);
console.log('sem rota (checagem de serviço ou nova):', naoUsadas.join(', '));
console.log('modelo -> nº capabilities:', Object.fromEntries(Object.entries(modelos).map(([k, v]) => [k, v.length])));
