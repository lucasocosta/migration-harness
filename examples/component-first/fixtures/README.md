Exemplo sintético do caso de uso P6 (componente sem rota + duas unidades ordenadas por dependência).
Nenhum valor aqui deriva de traces observados: todos os dados, rótulos e payloads são inventados.

Sem mocks de API: os dois hosts são estáticos, então `fixtures/` fica sem respostas de rede e a
superfície de avaliação é mínima. Se um futuro host precisar de GET, coloque o JSON aqui e declare
`mockInitialApiResponses` no cenário correspondente.
