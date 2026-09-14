/**
 * As páginas legais da loja — rodada 45.
 *
 * Vender online no Brasil exige três documentos à vista (LGPD, CDC e o
 * Decreto 7.962/2013 do comércio eletrônico): a política de privacidade, os
 * termos de uso e a política de trocas e devoluções. Até esta rodada não
 * existia NENHUM — nem página, nem rota, nem texto.
 *
 * O texto é escrito para gente, não para advogado ler em voz alta: cada
 * seção diz o que o sistema FAZ de verdade (o cartão nunca passa por aqui;
 * o CPF vai para a nota fiscal porque a SEFAZ exige; a sessão vive no
 * navegador). Prometer menos do que se faz é mentira tanto quanto prometer
 * mais.
 *
 * A identificação do fornecedor (razão social, CNPJ, endereço) vem do
 * endpoint público `/loja/identificacao` — o mesmo que alimenta o rodapé.
 * Fonte única: o que o gestor preencher no cadastro fiscal aparece aqui.
 */
import { Link } from 'react-router-dom';
import { CascaDaLoja } from '@/components/gs/CascaDaLoja';
import { useIdentificacaoLoja } from '@/hooks/useIdentificacaoLoja';

function QuemSomos() {
  const lojas = useIdentificacaoLoja();
  if (lojas.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="text-[length:var(--gs-text-base)]">Quem somos</h2>
      <ul className="list-none p-0 m-0 flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
        {lojas.map((l) => (
          <li key={l.slug}>
            <strong>{l.tradeName}</strong> — {l.legalName}
            {l.cnpj ? `, CNPJ ${l.cnpj}` : ''}
            {l.address ? ` — ${l.address}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PaginaLegal({
  titulo,
  atualizadaEm,
  children,
}: {
  titulo: string;
  atualizadaEm: string;
  children: React.ReactNode;
}) {
  return (
    <CascaDaLoja larguraMax="max-w-4xl">
      <article className="py-2">
        <h1 className="text-[length:var(--gs-text-lg)] mt-1">{titulo}</h1>
        <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Última atualização: {atualizadaEm}
        </p>
        <div className="mt-4 flex flex-col gap-4 leading-relaxed">{children}</div>
        <QuemSomos />
        <p className="mt-6 text-[length:var(--gs-text-sm)]">
          <Link to="/politica-de-privacidade">Política de Privacidade</Link>
          {' · '}
          <Link to="/termos-de-uso">Termos de Uso</Link>
          {' · '}
          <Link to="/trocas-e-devolucoes">Trocas e Devoluções</Link>
        </p>
      </article>
    </CascaDaLoja>
  );
}

const H = ({ children }: { children: React.ReactNode }) => (
  <h2 className="text-[length:var(--gs-text-base)] m-0 mt-2">{children}</h2>
);

export function PoliticaDePrivacidadePage() {
  return (
    <PaginaLegal titulo="Política de Privacidade" atualizadaEm="agosto de 2026">
      <p className="m-0">
        Esta política explica, em linguagem direta, quais dados pessoais as lojas do Grupo
        Sampaio coletam, para que servem e quais são os seus direitos, conforme a Lei Geral de
        Proteção de Dados (Lei nº 13.709/2018 — LGPD).
      </p>

      <H>O que coletamos, e por quê</H>
      <p className="m-0">
        <strong>Para processar um pedido:</strong> nome, CPF ou CNPJ, e-mail, telefone e
        endereço de entrega. O CPF/CNPJ é exigido pela legislação fiscal — ele vai na nota
        fiscal da compra. Sem esses dados não há como vender, entregar e emitir a nota (base
        legal: execução de contrato e obrigação legal).
      </p>
      <p className="m-0">
        <strong>Para a sua conta:</strong> e-mail e senha (guardada apenas como código
        irreversível — nem nós conseguimos lê-la). A conta mostra seus pedidos, endereços e,
        para clientes da oficina, os equipamentos e ordens de serviço em seu nome.
      </p>
      <p className="m-0">
        <strong>O que NÃO coletamos:</strong> os dados do seu cartão de crédito nunca passam
        pelos nossos sistemas — o pagamento com cartão acontece na página segura do provedor de
        pagamentos, e recebemos apenas a confirmação.
      </p>

      <H>Com quem compartilhamos</H>
      <p className="m-0">
        Somente com quem é necessário para cumprir o pedido: o provedor de pagamentos (para
        processar PIX, boleto e cartão), a transportadora (nome e endereço, para entregar) e a
        Secretaria da Fazenda (dados da nota fiscal, por obrigação legal). Não vendemos nem
        alugamos dados pessoais a ninguém.
      </p>

      <H>Cookies e armazenamento no navegador</H>
      <p className="m-0">
        A loja usa o armazenamento do seu navegador para lembrar o carrinho e manter a sua
        sessão quando você entra na conta. Não usamos rastreadores de publicidade de
        terceiros.
      </p>

      <H>Por quanto tempo guardamos</H>
      <p className="m-0">
        Dados de pedidos e notas fiscais ficam guardados pelos prazos que a legislação fiscal e
        de consumo exige. A conta pode ser encerrada a seu pedido; o histórico fiscal
        permanece pelo prazo legal.
      </p>

      <H>Seus direitos</H>
      <p className="m-0">
        A LGPD garante a você: confirmar se tratamos seus dados, acessá-los, corrigi-los,
        pedir a exclusão do que não for de guarda obrigatória, e revogar consentimentos. Para
        exercer qualquer direito, fale com a loja pelos contatos do rodapé — respondemos pelos
        canais oficiais de cada loja do grupo.
      </p>
    </PaginaLegal>
  );
}

export function TermosDeUsoPage() {
  return (
    <PaginaLegal titulo="Termos de Uso" atualizadaEm="agosto de 2026">
      <p className="m-0">
        Estes termos valem para o uso do site e das lojas online do Grupo Sampaio. Ao criar
        uma conta ou finalizar um pedido, você concorda com eles.
      </p>

      <H>A loja e os preços</H>
      <p className="m-0">
        Os preços e promoções exibidos valem para o momento da compra no site. O estoque é
        compartilhado com as lojas físicas: em caso raro de indisponibilidade após o pedido,
        você será avisado e reembolsado integralmente.
      </p>

      <H>Pagamento</H>
      <p className="m-0">
        Aceitamos PIX, boleto e cartão de crédito. O pagamento com cartão acontece na página
        segura do provedor de pagamentos — os dados do cartão não passam pelo nosso site e não
        são guardados por nós. O pedido é confirmado após a aprovação do pagamento.
      </p>

      <H>Sua conta</H>
      <p className="m-0">
        A conta é pessoal. Guarde sua senha; você pode encerrar as sessões de outros
        aparelhos a qualquer momento na área "Minha conta". Ao criar a conta, você aceita
        estes termos e a{' '}
        <Link to="/politica-de-privacidade">Política de Privacidade</Link> — e a data do seu
        aceite fica registrada.
      </p>

      <H>Entrega e retirada</H>
      <p className="m-0">
        O prazo de entrega é informado no fechamento do pedido, conforme o seu CEP. Também é
        possível retirar na loja, sem custo de frete, quando essa opção aparecer no
        checkout.
      </p>

      <H>Trocas, devoluções e arrependimento</H>
      <p className="m-0">
        Estão detalhados na <Link to="/trocas-e-devolucoes">Política de Trocas e
        Devoluções</Link>, incluindo o direito de arrependimento de 7 dias do Código de
        Defesa do Consumidor.
      </p>
    </PaginaLegal>
  );
}

export function TrocasEDevolucoesPage() {
  return (
    <PaginaLegal titulo="Trocas e Devoluções" atualizadaEm="agosto de 2026">
      <p className="m-0">
        Comprar online tem proteções próprias no Código de Defesa do Consumidor (Lei nº
        8.078/1990). Aqui está como elas funcionam nas lojas do Grupo Sampaio — sem letra
        miúda.
      </p>

      <H>Arrependimento: 7 dias para desistir</H>
      <p className="m-0">
        Em compras feitas pela internet, você pode desistir em até <strong>7 dias corridos</strong>{' '}
        a partir do recebimento do produto, sem precisar dar motivo (art. 49 do CDC). Nós
        devolvemos <strong>tudo o que você pagou</strong>, incluindo o frete, e o custo de
        devolução é nosso. O produto deve voltar com os acessórios e sem sinais de uso além
        do necessário para experimentar.
      </p>

      <H>Produto com defeito</H>
      <p className="m-0">
        Produto com vício tem prazo de reclamação de <strong>30 dias</strong> (não duráveis)
        ou <strong>90 dias</strong> (duráveis) a partir do recebimento (art. 26 do CDC). A
        loja tem até 30 dias para resolver; não resolvendo, você escolhe: troca por outro,
        devolução do valor corrigido, ou abatimento no preço (art. 18 do CDC). A garantia do
        fabricante, quando houver, soma-se a esses prazos.
      </p>

      <H>Como solicitar</H>
      <p className="m-0">
        Fale com a loja onde comprou — pelos contatos do rodapé ou pela área{' '}
        <Link to="/minha-conta">Minha conta</Link>, onde seus pedidos aparecem com a opção de
        atendimento. Tenha em mãos o número do pedido. O reembolso é feito pelo mesmo meio de
        pagamento da compra.
      </p>

      <H>Troca por outro tamanho ou modelo</H>
      <p className="m-0">
        Além do que a lei garante, trocas por tamanho ou cor podem ser combinadas diretamente
        com a loja, conforme a disponibilidade de estoque — é só chamar nos contatos do
        rodapé.
      </p>
    </PaginaLegal>
  );
}
