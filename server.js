const express = require('express');
const path = require('path');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const app = express();
const PORT = process.env.PORT || 8000;
// Configuração do MercadoPago
const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || 'APP_USR-7925949644716810-052315-77da801da84db789cb0db2d21d99bac8-2315174485',
    options: {
        timeout: 5000,
        idempotencyKey: 'abc'
    }
});

const payment = new Payment(client);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Banco de dados em memória para armazenar pagamentos
const payments = new Map();

// Rotas para servir as páginas HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/sucesso', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sucesso.html'));
});

app.get('/erro', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'erro.html'));
});

app.get('/pendente', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pendente.html'));
});

// Endpoint para criar pagamento
app.post('/create-payment', async (req, res) => {
    try {
        const { produto, comprador, payment_method, cartao } = req.body;
        console.log('Criando pagamento:', { produto, comprador, payment_method });
        // Preparar dados do pagamento
        const paymentData = {
            transaction_amount: produto.preco,
            description: produto.nome,
            payment_method_id: payment_method === 'pix' ? 'pix' : 'visa', // ou mastercard
            payer: {
                email: comprador.email,
                first_name: comprador.nome.split(' ')[0],
                last_name: comprador.nome.split(' ').slice(1).join(' ') || 'Silva',
                identification: {
                    type: 'CPF',
                    number: comprador.cpf.replace(/\D/g, '')
                }
            }
        };
        // Configurações específicas por método de pagamento
        if (payment_method === 'pix') {
            paymentData.payment_method_id = 'pix';
        } else if (payment_method === 'credit_card') {
            // Para cartão de crédito, você precisaria tokenizar primeiro
            // Este é um exemplo simplificado
            paymentData.payment_method_id = 'visa';
            paymentData.token = 'card_token_example'; // Token do cartão
            paymentData.installments = 1;
            paymentData.issuer_id = 310; // ID do emissor
        }
        // Criar pagamento no MercadoPago
        const response = await payment.create({ body: paymentData });
        console.log('Resposta do MercadoPago:', response);
        // Armazenar dados do pagamento localmente
        payments.set(response.id.toString(), {
            id: response.id,
            status: response.status,
            payment_method: payment_method,
            amount: produto.preco,
            payer: comprador,
            created_at: new Date(),
            qr_code: response.point_of_interaction?.transaction_data?.qr_code,
            qr_code_base64: response.point_of_interaction?.transaction_data?.qr_code_base64
        });
        // Resposta baseada no método de pagamento
        if (payment_method === 'pix') {
            res.json({
                success: true,
                payment_id: response.id,
                status: response.status,
                qr_code: response.point_of_interaction?.transaction_data?.qr_code || 'PIX_CODE_EXAMPLE',
                qr_code_base64: response.point_of_interaction?.transaction_data?.qr_code_base64
            });
        } else {
            // Para cartão de crédito
            if (response.status === 'approved') {
                res.json({
                    success: true,
                    payment_id: response.id,
                    status: response.status
                });
            } else {
                res.json({
                    success: false,
                    error: response.status_detail || 'Pagamento rejeitado',
                    payment_id: response.id
                });
            }
        }
    } catch (error) {
        console.error('Erro ao crear pagamento:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro interno do servidor',
            details: error.cause || null
        });
    }
});
// Endpoint para consultar status do pagamento
app.get('/payment-status/:id', async (req, res) => {
    const paymentId = req.params.id;
    try {
        // Primeiro verificar no banco local
        const localPayment = payments.get(paymentId);
        if (!localPayment) {
            return res.status(404).json({
                error: 'Pagamento não encontrado'
            });
        }
        // Consultar status atualizado no MercadoPago
        const response = await payment.get({ id: paymentId }); 
        // Atualizar status local
        payments.set(paymentId, {
            ...localPayment,
            status: response.status,
            updated_at: new Date()
        });
        res.json({
            id: response.id,
            status: response.status,
            status_detail: response.status_detail,
            payment_method: localPayment.payment_method,
            amount: response.transaction_amount
        });
    } catch (error) {
        console.error('Erro ao consultar pagamento:', error);
        // Se houver erro na consulta, retornar status local
        const localPayment = payments.get(paymentId);
        if (localPayment) {
            res.json({
                id: paymentId,
                status: localPayment.status,
                payment_method: localPayment.payment_method,
                amount: localPayment.amount,
                note: 'Status local (erro na consulta)'
            });
        } else {
            res.status(500).json({
                error: 'Erro ao consultar status do pagamento'
            });
        }
    }
});
// Endpoint para regenerar PIX
app.post('/regenerate-pix/:id', async (req, res) => {
    const paymentId = req.params.id;
    try {
        const localPayment = payments.get(paymentId);
        if (!localPayment || localPayment.payment_method !== 'pix') {
            return res.status(400).json({
                success: false,
                error: 'Pagamento PIX não encontrado'
            });
        }
        // Criar novo pagamento PIX
        const paymentData = {
            transaction_amount: localPayment.amount,
            description: `Renovação PIX - Pedido ${paymentId}`,
            payment_method_id: 'pix',
            payer: {
                email: localPayment.payer.email,
                first_name: localPayment.payer.nome.split(' ')[0],
                last_name: localPayment.payer.nome.split(' ').slice(1).join(' ') || 'Silva',
                identification: {
                    type: 'CPF',
                    number: localPayment.payer.cpf.replace(/\D/g, '')
                }
            }
        };
        const response = await payment.create({ body: paymentData });
        // Atualizar dados locais
        payments.set(response.id.toString(), {
            ...localPayment,
            id: response.id,
            status: response.status,
            qr_code: response.point_of_interaction?.transaction_data?.qr_code,
            qr_code_base64: response.point_of_interaction?.transaction_data?.qr_code_base64,
            updated_at: new Date()
        });
        res.json({
            success: true,
            payment_id: response.id,
            qr_code: response.point_of_interaction?.transaction_data?.qr_code || 'NEW_PIX_CODE_EXAMPLE',
            qr_code_base64: response.point_of_interaction?.transaction_data?.qr_code_base64
        });
    } catch (error) {
        console.error('Erro ao regenerar PIX:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao regenerar PIX'
        });
    }
});
// Webhook para receber notificações do MercadoPago
app.post('/webhook', async (req, res) => {
    console.log('Webhook recebido:', req.body);
    try {
        const { type, data } = req.body;
        if (type === 'payment') {
            const paymentId = data.id;
            // Consultar dados atualizados do pagamento
            const response = await payment.get({ id: paymentId });
            // Atualizar status local
            const localPayment = payments.get(paymentId.toString());
            if (localPayment) {
                payments.set(paymentId.toString(), {
                    ...localPayment,
                    status: response.status,
                    updated_at: new Date()
                });
                console.log(`Pagamento ${paymentId} atualizado: ${response.status}`);
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(500).send('Erro');
    }
});
// Endpoint para listar todos os pagamentos (para debug)
app.get('/payments', (req, res) => {
    const allPayments = Array.from(payments.values());
    res.json(allPayments);
});
// Endpoint de teste
app.get('/test', (req, res) => {
    res.json({
        message: 'Servidor funcionando!',
        timestamp: new Date(),
        payments_count: payments.size
    });
});
// Middleware de tratamento de erros
app.use((err, req, res, next) => {
    console.error('Erro no servidor:', err);
    res.status(500).json({
        error: 'Erro interno do servidor',
        message: err.message
    });
});
// Middleware para rotas não encontradas
app.use((req, res) => {
    res.status(404).json({
        error: 'Rota não encontrada',
        path: req.path
    });
});
// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
    // Configurações importantes
    console.log('\n🔧 CONFIGURAÇÕES NECESSÁRIAS:');
    console.log('1. Configure seu ACCESS_TOKEN do MercadoPago na variável de ambiente MERCADOPAGO_ACCESS_TOKEN');
    console.log('2. Configure o webhook no painel do MercadoPago apontando para: http://seu-dominio.com/webhook');
    console.log('3. Para teste, use o ngrok para expor sua aplicação local');
    console.log('\n📁 ESTRUTURA DE ARQUIVOS:');
    console.log('public/');
    console.log('  ├── index.html (página home)');
    console.log('  ├── sucesso.html (página de sucesso)');
    console.log('  ├── erro.html (página de erro)');
    console.log('  └── pendente.html (página PIX pendente)');
});
// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Encerrando servidor...');
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log('Encerrando servidor...');
    process.exit(0);
});