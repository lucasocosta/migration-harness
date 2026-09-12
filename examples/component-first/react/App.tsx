import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SeletorQuantidade } from './SeletorQuantidade';
import { FormularioPedido, type PedidoConfirmado } from './FormularioPedido';
import { designTokens, formatarPedido } from './design-system.mjs';

/**
 * Target side of the component-first example. Routes and accessible names match the Angular hosts exactly;
 * only `/host/seletor` (and the derived total) is deliberately unimplemented, see SeletorQuantidade.tsx.
 */
function HostSeletor() {
  const [quantidade, setQuantidade] = useState(2);
  return <main className={designTokens.pagina} aria-label="Host seletor de quantidade">
    <h1 className={designTokens.titulo}>SeletorQuantidade isolado</h1>
    <SeletorQuantidade valor={quantidade} minimo={0} maximo={5} rotulo="Quantidade" onChange={setQuantidade} />
    <p className={designTokens.rotulo}>Valor recebido pelo host via onChange</p>
    <p className={designTokens.alerta} role="status" aria-label="Valor enviado pelo host">{quantidade}</p>
  </main>;
}

function HostPedido() {
  const [confirmado, setConfirmado] = useState<string | null>(null);
  const registrar = (pedido: PedidoConfirmado): void => setConfirmado(formatarPedido(pedido));
  return <main className={designTokens.pagina} aria-label="Host formulario de pedido">
    <h1 className={designTokens.titulo}>FormularioPedido isolado</h1>
    <FormularioPedido precoUnitario={10} onConfirmar={registrar} />
    <p className={designTokens.alerta} role="alert" aria-label="Pedido confirmado" hidden={confirmado === null}>{confirmado}</p>
  </main>;
}

function Indice() {
  return <main className={designTokens.pagina} aria-label="Indice de hosts do exemplo">
    <h1 className={designTokens.titulo}>Hosts autorizados do exemplo</h1>
    <ul><li><a href="/host/seletor">Unidade A: seletor de quantidade</a></li>
    <li><a href="/host/pedido">Unidade B: formulário de pedido</a></li></ul>
  </main>;
}

function App() {
  const rota = window.location.pathname;
  return rota === '/host/seletor' ? <HostSeletor /> : rota === '/host/pedido' ? <HostPedido /> : <Indice />;
}
createRoot(document.querySelector('harness-root')!).render(<App />);
