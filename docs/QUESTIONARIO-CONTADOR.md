# Questionário de implantação contábil — uma reunião só

O objetivo deste documento é sair de UMA conversa com o contador com tudo o
que o Devora precisa para configurar o fiscal das seis empresas — sem trocar
mensagem pedindo campo por campo depois.

Cada pergunta diz **por que** precisamos e **onde** a resposta entra no
sistema. Leve este documento impresso ou na tela, e anote as respostas nele.

> Contexto para o contador: ERP próprio do Grupo Sampaio, seis CNPJs em
> Pelotas/RS, emissão própria de NFC-e (modelo 65) e NF-e (modelo 55) contra a
> SEFAZ-RS com certificado A1, XMLs guardados no sistema e entregues num
> pacote mensal por empresa (zip com XMLs emitidos, eventos, XMLs de compra
> originais, inutilizações e DRE em CSV).

---

## 1. EMPRESA (repetir por CNPJ — hoje o fiscal ativo é só a Preço Justo)

| # | Pergunta | Por quê | Exemplo | Onde entra no Devora |
| --- | --- | --- | --- | --- |
| 1.1 | Inscrição Estadual de cada CNPJ (e se alguma é isenta) | A IE vai no emitente de toda nota; sem ela o cadastro fiscal não fecha | `096/1234567` | Fiscal → Configuração → IE |
| 1.2 | O endereço fiscal de cada CNPJ confere com o cartão CNPJ? (logradouro, nº, bairro, CEP) | O endereço sai impresso na nota e diverge = rejeição/multa | — | Fiscal → Configuração → Endereço (IBGE de Pelotas 4314407 já é conhecido) |
| 1.3 | Quais das seis empresas VÃO emitir nota, e a partir de quando? | Cada uma precisa do próprio A1, série, CSC e grupo tributário — é implantação por empresa | "Preço Justo agora; PJ Motors em outubro" | Ordem de implantação |

## 2. REGIME

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 2.1 | Regime de CADA CNPJ: Simples Nacional (CRT 1), Simples com excesso de sublimite (CRT 2), MEI (CRT 4) ou regime normal (CRT 3)? Alguma perto do sublimite? | Decide o CRT e TODA a tributação da nota: CSOSN no Simples e no MEI, CST de ICMS no regime normal. O Devora emite os dois | "Todas Simples, CRT 1" | Fiscal → Configuração → CRT |
| 2.2 | Quais mercadorias de cada empresa são de substituição tributária (autopeças, cosméticos, bebidas…)? A ST vem **recolhida pelo fornecedor** (esta empresa é substituída) ou é **esta empresa que calcula e cobra** (substituta)? | Substituída: o item sai com CSOSN 500 (Simples) ou CST 60 (regime normal), e o Devora emite. Substituta (CSOSN 201/202/203, CST 10/30/70): o ICMS-ST é cobrado por fora e somaria ao total da nota; o Devora recusa essas notas dizendo o porquê — elas saem fora do sistema | "Peças e cosméticos: ST recolhida pelo fornecedor → CSOSN 500" | Grupo tributário → CSOSN / CST de ICMS |
| 2.3 | Alguma empresa tem benefício fiscal no RS que exige o código de benefício (cBenef) na nota? | O grupo tributário tem o campo, e ele sai em cada item quando preenchido | — | Grupo tributário → cBenef |

## 3. TRIBUTAÇÃO (a parte que destrava a emissão)

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 3.1 | O CSOSN padrão de venda é o 102 (sem crédito), o 101 (com crédito) ou o 500 (ST já recolhida)? Por empresa e por grupo de mercadoria | Já foi indicado 101; o sistema exige coerência | "101; peças 500" | Grupo tributário → CSOSN |
| 3.2 | **Se 101: qual a alíquota de crédito do Simples (pCredSN) de cada empresa, e quem nos avisa quando a faixa mudar?** | Sem pCredSN a emissão é recusada nomeando o campo — e o checklist fiscal já avisa antes da venda, com o contador como responsável. A alíquota muda com o faturamento acumulado — precisamos do número E da rotina de atualização | "2,80%" | Grupo tributário → pCredSN |
| 3.3 | CST de PIS/COFINS na saída (e, fora do Simples, a alíquota de PIS e a de COFINS) | Vai em cada item do XML; CST tributado sem alíquota é recusado | "49" | Grupo tributário + Catálogo → Alíquotas |
| 3.4 | **Só se alguma empresa for regime normal (CRT 3):** para cada grupo de mercadoria, o CST de ICMS (00, 20, 40, 41, 50, 60 ou 90), a alíquota de ICMS, o percentual de redução de base (CST 20) e se há FCP | Os CST 00 e 20 destacam ICMS: sem a alíquota a emissão é recusada nomeando o campo — o sistema não inventa imposto | "Geral 00 a 17%; perfumaria 00 a 25% + FCP 2%" | Catálogo → Alíquotas (tipo icms / fcp) + Grupo tributário |
| 3.5 | CFOP padrão: venda interna, venda interestadual, devolução | O CFOP interno e o interestadual do grupo valem para todo produto sem CFOP próprio (o sistema escolhe pela UF do destinatário); um produto só precisa de CFOP próprio quando for exceção | "5102 / 6102 / 1202" | Grupo tributário + config de entrada |
| 3.6 | Serviço de oficina (mão de obra) sai na NFC-e como item, em NFS-e municipal, ou não se documenta? | Hoje a linha de serviço entra na venda; se for NFS-e é sistema da prefeitura de Pelotas — escopo separado | — | Decisão de escopo |

## 4. PRODUTOS (confirmar o que o XML já disse — classificar só o resto)

O Devora lê o **NCM, o CEST e a origem** de cada item das notas de entrada e os
**sugere** para o produto casado, com a nota de onde vieram e quantas notas
concordam. O contador não precisa classificar por planilha o que o fornecedor
já declarou: ele **confirma as sugestões** (em lote, as inequívocas) e
classifica só o que ficar **PENDENTE** (nenhuma nota de entrada) ou
**DIVERGENTE** (fornecedores discordam, ou o arquivo contradiz o cadastro). O
**CFOP nunca é sugerido**: o do arquivo é a saída do fornecedor, não a nossa.

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 4.1 | O contador aceita **confirmar as sugestões do XML** de NCM, CEST e origem (em lote) e classificar só o que ficar PENDENTE ou DIVERGENTE? | O XML do fornecedor já declarou; redigitar é retrabalho. A confirmação é humana e fica registrada com autor e data | "Sim — confirmo as sugestões e classifico o resto" | Fiscal → Configuração → **Sugestões do XML do fornecedor** |
| 4.2 | Para os produtos PENDENTES (sem nota de entrada), quem classifica o NCM, e como prefere: na tela ou por planilha? | Item sem NCM não emite; o checklist conta quantos de quantos, e a tela lista as pendências por produto | "Classifico na tela" | Fiscal → Configuração → Pendências fiscais de produtos, ou Produtos → Alteração rápida |
| 4.3 | Nas DIVERGÊNCIAS (dois fornecedores com NCM, CEST ou origem diferentes para a mesma mercadoria), qual vale? | O Devora não escolhe: mostra os valores e quem declarou cada um. Origem e CEST também podem vir do grupo tributário, quando valem para todo o grupo | — | Fiscal → Configuração → Sugestões do XML do fornecedor |

## 5. NF-e / NFC-e (operacional)

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 5.1 | Série a usar por modelo e por empresa (NFC-e 65 e NF-e 55) — pode ser série 1, ou o contador prefere outra? | A numeração é configurada e travada no sistema; o contador precisa conhecer a série | "NFC-e série 1, NF-e série 1" | Fiscal → Configuração → Séries |
| 5.2 | Precisamos emitir NF-e (55) já no início — para quê? (venda a PJ? devolução a fornecedor? transferência entre os CNPJs?) | O montador da NFC-e está pronto; os casos de 55 definem a prioridade do que homologar | "Só devolução a fornecedor por ora" | Ordem de implantação |
| 5.3 | Transferência de mercadoria ENTRE as seis empresas: emitimos nota de transferência? Com qual CFOP? | Hoje o estoque é isolado por empresa; se há trânsito físico entre elas, o fiscal precisa acompanhar | "5152/6152" | Decisão + config |
| 5.4 | Cancelamento e inutilização: alguma orientação além do prazo legal (30 min/24 h do cancelamento de NFC-e no RS)? | O sistema já trata cancelamento como evento real da SEFAZ; queremos a rotina do escritório | — | Operação |

## 6. SPED / OBRIGAÇÕES (não afirmamos nada — perguntamos)

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 6.1 | Alguma das seis entrega EFD ICMS-IPI (SPED Fiscal) no RS, ou todas dispensadas como Simples? | O Devora NÃO gera SPED hoje e não vamos fingir que gera; se alguma precisar, é projeto com prazo | "Dispensadas" (esperado) | Escopo futuro |
| 6.2 | EFD-Contribuições: alguém entrega? | Mesma razão | "Não" (esperado) | Escopo futuro |
| 6.3 | Sintegra/RS ainda é exigido de alguma delas? | Resíduo estadual que só o contador confirma | — | Escopo futuro |
| 6.4 | Além do DAS: quais declarações mensais/anuais o escritório entrega por estas empresas (DEFIS, DIRF...) e o que precisa de NÓS para cada uma? | Vira o checklist da rotina mensal (seção 9) | — | Rotina mensal |

## 7. SOFTWARE CONTÁBIL

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 7.1 | Qual software o escritório usa (Domínio, Alterdata, Contmatic, outro)? | Define o formato de entrega que ELE importa | "Domínio" | Pacote do contador |
| 7.2 | O escritório importa XML de NF-e/NFC-e direto (nfeProc)? E o XML das notas de ENTRADA? | É exatamente o que nosso pacote mensal entrega hoje — se importar XML, a integração básica já está pronta | "Sim" | Pacote (já existe) |
| 7.3 | Que RELATÓRIOS ele quer além dos XMLs — e em que formato (CSV serve? precisa XLSX?) | Hoje o pacote leva DRE em CSV; vendas/compras/estoque tabulares são a próxima leva — priorizamos pelo que ele usa | "Faturamento por CFOP em CSV" | Backlog da Central do Contador |
| 7.4 | O escritório aceita acesso de LEITURA ao sistema (perfil `contador`, que enxerga só o fechamento fiscal)? | O perfil já existe: ele mesmo baixa o pacote todo mês, sem ninguém mandar nada | "Sim, mande o convite" | Equipe → perfil contador |

## 8. ROTINA MENSAL

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 8.1 | Dia do mês em que o escritório precisa do pacote fechado | Vira o combinado da operação (o pacote sai por mês-calendário, recorte no fuso da loja) | "até o dia 5" | Rotina |
| 8.2 | Canal de entrega: ele baixa (perfil contador) ou enviamos o zip? | Definir UM caminho | "Ele baixa" | Rotina |
| 8.3 | O que ele quer conferir ANTES do fechamento (prévia com pendências já existe: notas sem XML, faixas, cancelamentos) | A prévia lista pendências com código estável; combinar o que é bloqueante para ELE | — | Fiscal → Fechamento → Prévia |
| 8.4 | Inventário de fim de ano: em que formato ele precisa da posição de estoque? | Hoje a contagem existe na tela e não exporta — prioridade da próxima leva se ele exigir | "Planilha valorizada" | Backlog |

## 9. HOMOLOGAÇÃO (o primeiro dia fiscal)

| # | Pergunta | Por quê | Exemplo | Onde entra |
| --- | --- | --- | --- | --- |
| 9.1 | O contador acompanha a primeira emissão em HOMOLOGAÇÃO conosco (conferir DANFCE, chave, tributos)? | A homologação real contra a SEFAZ-RS é o portão para produção; quatro olhos no primeiro cupom | "Sim, quinta às 10h" | Agenda |
| 9.2 | Quem vira a chave para PRODUÇÃO: o dono decide sozinho ou só com o aval do escritório? | O sistema tranca produção até homologar; o combinado evita nota de produção precoce | — | Governança |

---

### O que NÃO precisamos perguntar (já resolvido no sistema)

Fuso/competência de Pelotas; guarda dos XMLs (banco + backup em nuvem);
numeração e séries travadas por empresa; QR Code v2 da NFC-e; cancelamento
como evento real; pacote mensal em zip com manifesto; isolamento entre os
seis CNPJs; validação de CPF/CNPJ no cadastro.

**O NCM, o CEST e a origem de cada produto que já passou por uma nota de
entrada**: o sistema os sugere a partir do XML do fornecedor, com procedência e
contagem, e o contador só confirma (seção 4) — a classificação por planilha fica
para o que ficar PENDENTE ou DIVERGENTE. **CNPJ, razão social, validade e
emissor do certificado A1**: lidos do próprio arquivo. **O que falta em cada
grupo tributário**: o checklist fiscal lista, por grupo e com o contador como
responsável, tudo o que a emissão vai exigir (pCredSN, CST de PIS/COFINS,
alíquota de ICMS…) — antes da primeira venda.
