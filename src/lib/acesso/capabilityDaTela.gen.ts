/**
 * GERADO por scripts/rbac/gerar-capability-da-tela.mjs a partir de scripts/rbac/mapa-final.json.
 * Não edite à mão: regenere.
 *
 * A capability de cada tela (caminho do roteador, com :parametros) na forma de texto
 * `capability`, `qualquer(a, b)` ou `todas(a, b)`. Usada para quem tem acesso PERSONALIZADO.
 */
export const CAPABILITY_DA_TELA: Readonly<Record<string, string>> = {
  "(grupo/pendente) CRM (grupo)": "crm.view",
  "(grupo/pendente) Compras (grupo)": "qualquer(purchases.view, purchases.receive)",
  "(grupo/pendente) Configurações (grupo)": "qualquer(settings.sale_policy.manage, sales.view, settings.management_policy.manage, dashboard.view, integrations.status.view, integrations.asaas.manage, integrations.google_login.manage, integrations.asaas.reconcile, integrations.sync.operate, settings.printers.view, system.deploy.view, system.backup.view, system.status.view, settings.terminals.manage, pdv.terminal.activation, group.companies.manage)",
  "(grupo/pendente) Configurações > Automações (pendente)": "dashboard.view",
  "(grupo/pendente) E-commerce (grupo)": "qualquer(ecommerce.store.manage, products.manage, ecommerce.orders.view, ecommerce.shipping.manage, ecommerce.emails.manage, logistics.manage)",
  "(grupo/pendente) Estoque (grupo)": "qualquer(inventory.view, inventory.units.view, purchases.view, purchases.receive, products.manage, inventory.manage)",
  "(grupo/pendente) Financeiro (grupo)": "qualquer(finance.view, finance.advanced.view, finance.commissions.manage, finance.acquirers.manage, finance.bank_reconciliation.manage)",
  "(grupo/pendente) Fiscal (grupo)": "qualquer(fiscal.sale.emit, fiscal.view, accounting.closing.view, fiscal.certificate.manage)",
  "(grupo/pendente) Locação (grupo)": "rentals.view",
  "(grupo/pendente) Oficina (grupo)": "qualquer(workshop.kanban.view, workshop.equipment.view, workshop.tags.view, users.view, workshop.benches.view, workshop.parts.view)",
  "(grupo/pendente) Pessoas (grupo)": "qualquer(customers.view, purchases.view, users.view)",
  "(grupo/pendente) Produtos (grupo)": "qualquer(products.view, products.manage)",
  "(grupo/pendente) Relatórios (grupo)": "qualquer(dashboard.view, reports.central.view, reports.bi.view, audit.view)",
  "(grupo/pendente) Vendas (grupo)": "qualquer(sales.view, pdv.sell, pdv.supervise, pdv.cash.operate)",
  "(≈70 telas do escritório)": "dashboard.view",
  "/": "dashboard.view",
  "/pdv": "pdv.sell",
  "/sistema": "dashboard.view",
  "/sistema/balanca": "products.view",
  "/sistema/caixa": "qualquer(pdv.cash.operate, sales.view)",
  "/sistema/clientes": "customers.view",
  "/sistema/compras/conciliacao": "purchases.view",
  "/sistema/compras/configuracao": "purchases.view",
  "/sistema/compras/devolucoes": "purchases.view",
  "/sistema/compras/entrada-notas": "purchases.receive",
  "/sistema/compras/fornecedores": "purchases.view",
  "/sistema/compras/nfe-email": "purchases.view",
  "/sistema/compras/pedidos": "purchases.view",
  "/sistema/compras/transportadoras": "purchases.view",
  "/sistema/conferencia-maquininha": "pdv.supervise",
  "/sistema/configuracoes/backup": "system.backup.view",
  "/sistema/configuracoes/implantacao": "system.deploy.view",
  "/sistema/configuracoes/impressoras": "settings.printers.view",
  "/sistema/configuracoes/maquininhas": "pdv.terminal.activation",
  "/sistema/configuracoes/politica-de-gestao": "qualquer(settings.management_policy.manage, dashboard.view)",
  "/sistema/configuracoes/politica-de-venda": "qualquer(settings.sale_policy.manage, sales.view)",
  "/sistema/configuracoes/sistema": "system.status.view",
  "/sistema/configuracoes/terminais": "settings.terminals.manage",
  "/sistema/consignacoes": "sales.view",
  "/sistema/crm/fidelidade": "crm.view",
  "/sistema/crm/leads": "crm.view",
  "/sistema/cupons": "products.view",
  "/sistema/empresas": "group.companies.manage",
  "/sistema/empresas/:companyId/implantacao": "system.deploy.view",
  "/sistema/equipamentos": "workshop.equipment.view",
  "/sistema/equipamentos/:id": "workshop.equipment.view",
  "/sistema/equipamentos/plaquinhas": "workshop.tags.view",
  "/sistema/estoque": "inventory.view",
  "/sistema/estoque/importacao-planilha": "products.manage",
  "/sistema/estoque/inventario": "inventory.manage",
  "/sistema/estoque/locais": "inventory.view",
  "/sistema/estoque/movimentacoes": "inventory.view",
  "/sistema/estoque/unidades": "inventory.units.view",
  "/sistema/estoque/validade": "inventory.view",
  "/sistema/etiquetas": "products.view",
  "/sistema/financeiro": "finance.view",
  "/sistema/financeiro/cadastros": "finance.advanced.view",
  "/sistema/financeiro/comissoes": "finance.commissions.manage",
  "/sistema/financeiro/conciliacao": "finance.bank_reconciliation.manage",
  "/sistema/financeiro/contas-a-pagar": "finance.view",
  "/sistema/financeiro/contas-a-receber": "finance.view",
  "/sistema/financeiro/dre": "finance.view",
  "/sistema/financeiro/fluxo-de-caixa": "finance.advanced.view",
  "/sistema/financeiro/operadoras": "finance.acquirers.manage",
  "/sistema/fiscal/certificado": "fiscal.certificate.manage",
  "/sistema/fiscal/configuracao": "fiscal.view",
  "/sistema/fiscal/documentos": "qualquer(fiscal.sale.emit, fiscal.view)",
  "/sistema/fiscal/fechamento": "accounting.closing.view",
  "/sistema/fiscal/inutilizacoes": "fiscal.view",
  "/sistema/fiscal/operacoes": "fiscal.view",
  "/sistema/integracoes": "integrations.status.view",
  "/sistema/integracoes/asaas": "integrations.asaas.manage",
  "/sistema/integracoes/asaas/conciliacao": "integrations.asaas.reconcile",
  "/sistema/integracoes/central": "integrations.sync.operate",
  "/sistema/integracoes/google": "integrations.google_login.manage",
  "/sistema/locacao/contratos": "rentals.view",
  "/sistema/loja/administracao": "ecommerce.store.manage",
  "/sistema/loja/emails": "ecommerce.emails.manage",
  "/sistema/loja/entrega": "ecommerce.shipping.manage",
  "/sistema/loja/fotos": "products.manage",
  "/sistema/loja/logistica": "logistics.manage",
  "/sistema/loja/prontidao": "ecommerce.store.manage",
  "/sistema/oficina": "workshop.kanban.view",
  "/sistema/oficina, /os/:id, /sistema/equipamentos*, /sistema/oficina/pecas": "qualquer(workshop.kanban.view, workshop.equipment.view, workshop.tags.view, workshop.parts.view)",
  "/sistema/oficina/mecanicos": "users.view",
  "/sistema/oficina/oficinas": "workshop.benches.view",
  "/sistema/oficina/os/:id": "workshop.kanban.view",
  "/sistema/oficina/pecas": "workshop.parts.view",
  "/sistema/orcamentos": "sales.view",
  "/sistema/painel": "dashboard.view",
  "/sistema/pedidos": "ecommerce.orders.view",
  "/sistema/produtos": "products.view",
  "/sistema/produtos/:id": "products.view",
  "/sistema/produtos/alteracao-rapida": "products.view",
  "/sistema/produtos/auxiliares": "products.view",
  "/sistema/produtos/categorias": "products.view",
  "/sistema/produtos/novo": "products.manage",
  "/sistema/produtos/prontidao-online": "products.manage",
  "/sistema/promocoes": "products.view",
  "/sistema/relatorios/auditoria": "audit.view",
  "/sistema/relatorios/bi": "reports.bi.view",
  "/sistema/relatorios/central": "reports.central.view",
  "/sistema/usuarios": "users.view",
  "/sistema/vendas": "sales.view",
  "/sistema/vendas/devolucoes": "sales.view",
};

/** O catálogo agrupado por área, para o editor de acesso da tela de Usuários. */
export const AREAS_DO_CATALOGO: ReadonlyArray<{ area: string; capabilities: ReadonlyArray<{ code: string; label: string; escopo: string }> }> = [
  {
    "area": "Grupo",
    "capabilities": [
      {
        "code": "group.admin",
        "label": "Administrar o grupo",
        "escopo": "grupo"
      },
      {
        "code": "group.companies.manage",
        "label": "Empresas do grupo",
        "escopo": "grupo"
      },
      {
        "code": "group.dashboard.view",
        "label": "Painel do grupo (visões consolidadas)",
        "escopo": "grupo"
      },
      {
        "code": "group.audit.view",
        "label": "Auditoria do grupo",
        "escopo": "grupo"
      }
    ]
  },
  {
    "area": "Relatórios",
    "capabilities": [
      {
        "code": "audit.view",
        "label": "Auditoria da empresa",
        "escopo": "empresa"
      },
      {
        "code": "reports.central.view",
        "label": "Central de relatórios",
        "escopo": "empresa"
      },
      {
        "code": "reports.bi.view",
        "label": "BI",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Usuários",
    "capabilities": [
      {
        "code": "permissions.templates.manage",
        "label": "Modelos de permissão",
        "escopo": "grupo"
      },
      {
        "code": "users.password_recovery.manage",
        "label": "\"Esqueci minha senha\" da equipe",
        "escopo": "empresa"
      },
      {
        "code": "users.view",
        "label": "Usuários e equipe (ver)",
        "escopo": "empresa"
      },
      {
        "code": "users.manage",
        "label": "Usuários e equipe (cadastrar, editar, vincular)",
        "escopo": "empresa"
      },
      {
        "code": "users.deactivate",
        "label": "Desativar/reativar conta",
        "escopo": "empresa"
      },
      {
        "code": "users.reset_password",
        "label": "Redefinir senha",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Sistema",
    "capabilities": [
      {
        "code": "system.status.view",
        "label": "Estado do sistema",
        "escopo": "grupo"
      },
      {
        "code": "system.secrets.view",
        "label": "Cofre de segredos (conferência)",
        "escopo": "grupo"
      },
      {
        "code": "system.deploy.view",
        "label": "Implantação (ver)",
        "escopo": "grupo"
      },
      {
        "code": "system.deploy.manage",
        "label": "Implantação (marcar itens)",
        "escopo": "grupo"
      },
      {
        "code": "system.backup.view",
        "label": "Backup (ver)",
        "escopo": "grupo"
      },
      {
        "code": "system.backup.manage",
        "label": "Backup (conferir destino)",
        "escopo": "grupo"
      }
    ]
  },
  {
    "area": "Integrações",
    "capabilities": [
      {
        "code": "integrations.google_login.manage",
        "label": "Entrar com Google (loja)",
        "escopo": "grupo"
      },
      {
        "code": "devices.view",
        "label": "Tokens de terminal (ver)",
        "escopo": "empresa"
      },
      {
        "code": "devices.manage",
        "label": "Tokens de terminal (registrar/revogar)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.status.view",
        "label": "Integrações (estado)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.asaas.view",
        "label": "Asaas (ver)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.asaas.manage",
        "label": "Asaas (credencial, homologar, produção)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.asaas.reconcile",
        "label": "Conciliação Asaas",
        "escopo": "empresa"
      },
      {
        "code": "integrations.card_terminal.view",
        "label": "Maquininha (ver)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.card_terminal.operate",
        "label": "Maquininha (operar)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.card_terminal.manage",
        "label": "Maquininha (configurar)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.sync.operate",
        "label": "Banco central (sincronizar)",
        "escopo": "empresa"
      },
      {
        "code": "integrations.sync.admin",
        "label": "Banco central (carga, sonda, reviver)",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Configurações",
    "capabilities": [
      {
        "code": "settings.management_policy.manage",
        "label": "Política de gestão (salvar)",
        "escopo": "empresa"
      },
      {
        "code": "settings.sale_policy.manage",
        "label": "Política do balcão",
        "escopo": "empresa"
      },
      {
        "code": "settings.printers.view",
        "label": "Impressoras (ver)",
        "escopo": "empresa"
      },
      {
        "code": "settings.printers.manage",
        "label": "Impressoras (cadastrar, testar)",
        "escopo": "empresa"
      },
      {
        "code": "settings.terminals.manage",
        "label": "Caixas e terminais",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Fiscal",
    "capabilities": [
      {
        "code": "fiscal.certificate.manage",
        "label": "Certificado A1",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.policy.manage",
        "label": "Políticas fiscais e produção",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.view",
        "label": "Fiscal (ver)",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.manage",
        "label": "Fiscal (operar documentos)",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.config.manage",
        "label": "Configuração fiscal",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.csc.manage",
        "label": "CSC da NFC-e",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.documents.cancel",
        "label": "Cancelar nota, CC-e e inutilizar",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.sale.emit",
        "label": "Emitir a nota da venda",
        "escopo": "empresa"
      },
      {
        "code": "fiscal.products.classify",
        "label": "Classificação fiscal de produtos",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Painel",
    "capabilities": [
      {
        "code": "dashboard.view",
        "label": "Página principal do gestor",
        "escopo": "empresa"
      },
      {
        "code": "dashboard.money.view",
        "label": "Dinheiro no painel",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "PDV",
    "capabilities": [
      {
        "code": "pdv.sell",
        "label": "Vender no PDV",
        "escopo": "pdv"
      },
      {
        "code": "pdv.cash.operate",
        "label": "Operar caixa (gaveta)",
        "escopo": "pdv"
      },
      {
        "code": "pdv.payment.charge",
        "label": "Cobrar na maquininha",
        "escopo": "pdv"
      },
      {
        "code": "pdv.backoffice",
        "label": "Retaguarda pelo balcão",
        "escopo": "empresa"
      },
      {
        "code": "pdv.supervise",
        "label": "Conferência do PDV",
        "escopo": "empresa"
      },
      {
        "code": "pdv.terminal.activation",
        "label": "Ligar/desligar maquininha por caixa",
        "escopo": "empresa"
      },
      {
        "code": "pdv.device_login",
        "label": "Entrar por token de computador do caixa",
        "escopo": "pdv"
      }
    ]
  },
  {
    "area": "Vendas",
    "capabilities": [
      {
        "code": "sales.view",
        "label": "Vendas (ver)",
        "escopo": "empresa"
      },
      {
        "code": "sales.supervise",
        "label": "Supervisão de vendas",
        "escopo": "empresa"
      },
      {
        "code": "sales.quotes.manage",
        "label": "Orçamentos e pré-vendas",
        "escopo": "empresa"
      },
      {
        "code": "sales.consignment.manage",
        "label": "Consignação (condicional)",
        "escopo": "empresa"
      },
      {
        "code": "sales.returns.operate",
        "label": "Cancelar e devolver venda",
        "escopo": "empresa"
      },
      {
        "code": "sales.cancel.direct",
        "label": "Cancelar venda sem liberação",
        "escopo": "empresa"
      },
      {
        "code": "sales.quotes.cancel",
        "label": "Cancelar orçamento",
        "escopo": "empresa"
      },
      {
        "code": "sales.consignment.close",
        "label": "Fechar consignação",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Alçada",
    "capabilities": [
      {
        "code": "approval.discount",
        "label": "Liberar desconto acima do limite",
        "escopo": "empresa"
      },
      {
        "code": "approval.cash_withdrawal",
        "label": "Liberar sangria especial",
        "escopo": "empresa"
      },
      {
        "code": "approval.cash_reopen",
        "label": "Liberar reabertura de caixa",
        "escopo": "empresa"
      },
      {
        "code": "approval.sale_cancel",
        "label": "Liberar cancelamento de venda",
        "escopo": "empresa"
      },
      {
        "code": "approval.sale_return",
        "label": "Liberar devolução de venda",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Clientes",
    "capabilities": [
      {
        "code": "customers.view",
        "label": "Clientes (ver)",
        "escopo": "empresa"
      },
      {
        "code": "customers.manage",
        "label": "Clientes (cadastrar/editar)",
        "escopo": "empresa"
      },
      {
        "code": "customers.contact.view",
        "label": "Contato completo do cliente",
        "escopo": "empresa"
      },
      {
        "code": "customers.privacy.manage",
        "label": "LGPD do titular",
        "escopo": "empresa"
      },
      {
        "code": "customers.portal.invite",
        "label": "Convidar para o portal",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Produtos",
    "capabilities": [
      {
        "code": "products.view",
        "label": "Produtos (ver)",
        "escopo": "empresa"
      },
      {
        "code": "products.manage",
        "label": "Produtos (cadastrar/editar)",
        "escopo": "empresa"
      },
      {
        "code": "products.price.manage",
        "label": "Preços e tabelas de preço",
        "escopo": "empresa"
      },
      {
        "code": "products.catalog.admin",
        "label": "Catálogo (excluir/mesclar, confirmar importação)",
        "escopo": "empresa"
      },
      {
        "code": "labels.products.print",
        "label": "Etiquetas de produto",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Oficina",
    "capabilities": [
      {
        "code": "labels.equipment.print",
        "label": "Etiquetas de equipamento (folha)",
        "escopo": "empresa"
      },
      {
        "code": "workshop.equipment.label",
        "label": "Etiqueta do equipamento da OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.kanban.view",
        "label": "Oficina: ver kanban e OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.orders.open",
        "label": "Abrir OS e atender",
        "escopo": "bancada"
      },
      {
        "code": "workshop.orders.move",
        "label": "Mover OS no kanban",
        "escopo": "bancada"
      },
      {
        "code": "workshop.orders.assume",
        "label": "Assumir e liberar OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.orders.plan",
        "label": "Planejar OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.parts.use",
        "label": "Peças na OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.labor.manage",
        "label": "Mão de obra na OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.orders.complete",
        "label": "Concluir OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.quote.request",
        "label": "Orçamento da OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.checkout",
        "label": "Checkout da OS",
        "escopo": "bancada"
      },
      {
        "code": "workshop.checkout.refund",
        "label": "Estornar OS sem liberação",
        "escopo": "bancada"
      },
      {
        "code": "workshop.admin",
        "label": "Gerência da oficina",
        "escopo": "bancada"
      },
      {
        "code": "workshop.tickets.manage",
        "label": "Chamados",
        "escopo": "bancada"
      },
      {
        "code": "workshop.parts.view",
        "label": "Peças (ver)",
        "escopo": "bancada"
      },
      {
        "code": "workshop.parts.manage",
        "label": "Peças (cadastrar, repor)",
        "escopo": "bancada"
      },
      {
        "code": "workshop.parts.cost.view",
        "label": "Custo da peça",
        "escopo": "bancada"
      },
      {
        "code": "workshop.equipment.view",
        "label": "Equipamentos (ver)",
        "escopo": "bancada"
      },
      {
        "code": "workshop.equipment.manage",
        "label": "Equipamentos (editar)",
        "escopo": "bancada"
      },
      {
        "code": "workshop.equipment.owner",
        "label": "Dono do equipamento",
        "escopo": "empresa"
      },
      {
        "code": "workshop.tags.view",
        "label": "Plaquinhas (ver)",
        "escopo": "empresa"
      },
      {
        "code": "workshop.tags.print",
        "label": "Plaquinhas (gerar e imprimir)",
        "escopo": "empresa"
      },
      {
        "code": "workshop.tags.release",
        "label": "Plaquinhas (liberar para uso)",
        "escopo": "empresa"
      },
      {
        "code": "workshop.tags.layout",
        "label": "Plaquinhas (layout)",
        "escopo": "empresa"
      },
      {
        "code": "workshop.benches.view",
        "label": "Oficinas e bancadas (ver)",
        "escopo": "empresa"
      },
      {
        "code": "workshop.benches.manage",
        "label": "Oficinas e bancadas (membros, marca)",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Estoque",
    "capabilities": [
      {
        "code": "inventory.view",
        "label": "Estoque (ver)",
        "escopo": "empresa"
      },
      {
        "code": "inventory.manage",
        "label": "Estoque (movimentar)",
        "escopo": "empresa"
      },
      {
        "code": "inventory.adjust.approve",
        "label": "Aplicar ajuste de inventário",
        "escopo": "empresa"
      },
      {
        "code": "inventory.cost.view",
        "label": "Custo do estoque",
        "escopo": "empresa"
      },
      {
        "code": "inventory.units.view",
        "label": "Unidades serializadas (PJ Motors: chassi)",
        "escopo": "empresa"
      },
      {
        "code": "inventory.units.manage",
        "label": "Unidades serializadas (editar, baixar, ligar equipamento)",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Compras",
    "capabilities": [
      {
        "code": "purchases.view",
        "label": "Compras (ver)",
        "escopo": "empresa"
      },
      {
        "code": "purchases.receive",
        "label": "Entrada de notas",
        "escopo": "empresa"
      },
      {
        "code": "purchases.manage",
        "label": "Compras (gerir)",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Financeiro",
    "capabilities": [
      {
        "code": "finance.view",
        "label": "Financeiro (ver)",
        "escopo": "empresa"
      },
      {
        "code": "finance.advanced.view",
        "label": "Fluxo de caixa e saldos",
        "escopo": "empresa"
      },
      {
        "code": "finance.manage",
        "label": "Financeiro (lançar e baixar)",
        "escopo": "empresa"
      },
      {
        "code": "finance.commissions.manage",
        "label": "Comissões",
        "escopo": "empresa"
      },
      {
        "code": "finance.acquirers.manage",
        "label": "Operadoras de cartão",
        "escopo": "empresa"
      },
      {
        "code": "finance.bank_reconciliation.manage",
        "label": "Conciliação bancária",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Contabilidade",
    "capabilities": [
      {
        "code": "accounting.closing.view",
        "label": "Fechamento do mês (ver e baixar)",
        "escopo": "empresa"
      },
      {
        "code": "accounting.closing.send",
        "label": "Enviar ao contador",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Locação",
    "capabilities": [
      {
        "code": "rentals.view",
        "label": "Locação (ver)",
        "escopo": "empresa"
      },
      {
        "code": "rentals.manage",
        "label": "Locação (contratar, devolver)",
        "escopo": "empresa"
      },
      {
        "code": "rentals.cancel",
        "label": "Cancelar locação",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "CRM",
    "capabilities": [
      {
        "code": "crm.view",
        "label": "CRM (ver)",
        "escopo": "empresa"
      },
      {
        "code": "crm.leads.manage",
        "label": "Leads e oportunidades",
        "escopo": "empresa"
      },
      {
        "code": "crm.opportunities.close",
        "label": "Converter lead e fechar oportunidade",
        "escopo": "empresa"
      },
      {
        "code": "crm.loyalty.config",
        "label": "Programa de fidelidade",
        "escopo": "empresa"
      },
      {
        "code": "crm.loyalty.redeem",
        "label": "Resgatar pontos",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "E-commerce",
    "capabilities": [
      {
        "code": "ecommerce.orders.view",
        "label": "Pedidos online (ver)",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.orders.fulfill",
        "label": "Separar e expedir pedido",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.orders.service",
        "label": "Atender pedido (cancelar, decidir devolução)",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.orders.receive_return",
        "label": "Receber devolução do pedido",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.orders.manage",
        "label": "Pedidos online (gerir)",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.store.manage",
        "label": "Administração da loja",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.shipping.manage",
        "label": "Entrega da loja",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.emails.manage",
        "label": "E-mails da loja",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.publish",
        "label": "Publicar produtos prontos",
        "escopo": "empresa"
      },
      {
        "code": "ecommerce.promotions.manage",
        "label": "Promoções e cupons",
        "escopo": "empresa"
      }
    ]
  },
  {
    "area": "Logística",
    "capabilities": [
      {
        "code": "logistics.view",
        "label": "Logística (ver)",
        "escopo": "empresa"
      },
      {
        "code": "logistics.manage",
        "label": "Logística (cotar, etiquetar)",
        "escopo": "empresa"
      }
    ]
  }
];
