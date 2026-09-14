/**
 * Compras › Configuração da entrada.
 *
 * ## O erro fiscal que esta tela fecha
 *
 * Quando a entrada de nota encontra um item que ainda não existe no catálogo,
 * ela cria o produto — e copiava o CFOP do ITEM DA NOTA para o cadastro. Esse
 * CFOP é o do FORNECEDOR, escrito na ótica dele: comprando de outro estado a
 * nota traz 6102, "venda interestadual", e o produto da loja nascia 6102.
 *
 * Depois a loja vende no balcão, e o gerador da NFC-e lê o CFOP do produto e o
 * joga direto no XML. A venda local sai declarada como operação interestadual.
 *
 * Nada denuncia: o produto tem CFOP, o cupom emite, a SEFAZ autoriza — 6102 é
 * um código válido. O erro só aparece meses depois, na apuração do contador.
 *
 * ## Deixar em branco não bloqueia nada
 *
 * Em branco mantém exatamente o comportamento antigo. A alternativa — recusar
 * a entrada enquanto ninguém configurar — pararia o recebimento de mercadoria
 * por causa de um campo, e nota que não entra é muito pior que CFOP a
 * corrigir depois.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Button, Card, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';

export default function ConfiguracaoEntradaPage() {
  const [cfop, setCfop] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setErro(null);
      const cfg = await coreApi.getInboundConfig();
      setCfop(cfg.defaultSaleCfop ?? '');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a configuração.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const cfg = await coreApi.setInboundConfig({ defaultSaleCfop: cfop.trim() || null });
      setCfop(cfg.defaultSaleCfop ?? '');
      setAviso(
        cfg.defaultSaleCfop
          ? `Pronto. Produto novo criado por entrada de nota nasce com CFOP ${cfg.defaultSaleCfop}.`
          : 'Configuração limpa. O produto volta a herdar o CFOP do fornecedor.',
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Compras', 'Configuração da entrada']}
        title="Configuração da entrada"
        subtitle="O que vale para toda nota que entrar."
      />

      {erro && (
        <Card>
          <p role="alert">{erro}</p>
        </Card>
      )}
      {aviso && (
        <Card>
          <p>{aviso}</p>
        </Card>
      )}

      <Card>
        <h3>CFOP de venda</h3>
        <p>
          O CFOP com que a <strong>sua loja vende</strong>, gravado no produto que a entrada de
          nota criar. Não é o CFOP da compra: aquele continua guardado na nota, exatamente como o
          fornecedor declarou.
        </p>
        <p>
          Sem isto, o produto novo herda o CFOP do fornecedor. Quem compra de outro estado recebe
          notas com 6102 — venda interestadual — e passa a emitir cupom de balcão com código de
          operação entre estados.
        </p>
        <Field label="CFOP padrão de venda">
          {(p) => (
            <Input
              {...p}
              value={cfop}
              placeholder="5102"
              onChange={(e) => setCfop(e.target.value)}
              inputMode="numeric"
            />
          )}
        </Field>
        <p>
          Quatro dígitos começando em <strong>5</strong> (dentro do estado), <strong>6</strong>{' '}
          (outro estado) ou <strong>7</strong> (exterior). Em branco mantém o comportamento atual.
        </p>
        <Button onClick={() => void salvar()} disabled={salvando}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </Button>
      </Card>

      {/*
        O que NÃO está aqui, e por quê — escrito na tela para não ser pedido de
        novo como se tivesse sido esquecido.
      */}
      <Card>
        <h3>O que ainda não dá para configurar</h3>
        <p>
          <strong>Estoque de destino da entrada.</strong> Só a entrada passaria a gravar o local;
          toda saída — PDV, ordem de serviço, devolução, contagem — continua sem informar de onde
          a peça saiu. Receber 10 no depósito e vender 3 no balcão deixaria +10 num local e −3 no
          outro, e a transferência passaria a oferecer peça já vendida. Entra quando a venda
          souber de onde a mercadoria sai.
        </p>
        <p>
          <strong>Tabela de preço padrão.</strong> O assistente de reprecificação avaliaria a
          margem pelo preço da tabela e continuaria gravando o preço base — o alerta nasceria
          impossível de zerar, e aplicar as sugestões abaixaria o preço de prateleira. Entra
          quando a tabela de preço valer na venda.
        </p>
      </Card>
    </AppShell>
  );
}
