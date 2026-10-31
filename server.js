require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- NUEVO: Configuración para el tiempo real (WebSockets) ---
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } }); 
io.on('connection', (socket) => {
    console.log('🔌 ¡Una pantalla se ha conectado al sistema en vivo!');
});

// -------------------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get('/', (req, res) => {
    res.send('¡El servidor POS de la heladería está vivo! 🍦');
});

// --- RUTA: Obtener el catálogo de categorías ---
app.get('/api/categorias', async (req, res) => {
    try {
        const { data, error } = await supabase.from('categorias').select('*');
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVA RUTA: Buscar producto por código de barras ---
app.get('/api/productos/codigo/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const { data, error } = await supabase
            .from('producto_variantes')
            .select(`
                id, nombre_variante, precio, stock_actual,
                productos!inner ( id, nombre_producto, categoria_id )
            `)
            .eq('codigo_barras', codigo)
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(404).json({ error: 'Producto no encontrado con ese código' });
    }
});

// --- RUTA: Obtener el menú completo ---
app.get('/api/menu', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('productos')
            .select(`id, nombre_producto, categoria_id, producto_variantes (id, nombre_variante, precio)`)
            .eq('disponible', true); 

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- RUTA INTEGRADA: Registrar venta, descontar stock, etc ---
app.post('/api/pedidos', async (req, res) => {
    try {
        const { total, metodo_pago, detalles, turno_id, observaciones, celular_cliente, premios_canjeados } = req.body;
        const fecha_hora = new Date().toISOString();

        const { data: pedido, error: errorPedido } = await supabase
            .from('pedidos')
            .insert([{ turno_id, fecha_hora, total, metodo_pago, estado: 'Pendiente', observaciones: observaciones || '' }])
            .select()
            .single();

        if (errorPedido) throw errorPedido;

        const detallesParaInsertar = detalles.map(item => ({
            pedido_id: pedido.id,
            producto_variante_id: item.variante_id,
            cantidad: item.cantidad,
            subtotal: item.subtotal,
            notas_especiales: item.notas
        }));

        const { error: errorDetalles } = await supabase.from('detalle_pedidos').insert(detallesParaInsertar);
        if (errorDetalles) throw errorDetalles;

        for (let item of detalles) {
            if (item.variante_id) {
                const { data: varianteData } = await supabase
                    .from('producto_variantes')
                    .select(`stock_actual, productos ( controla_inventario )`)
                    .eq('id', item.variante_id)
                    .single();

                if (varianteData && varianteData.productos.controla_inventario) {
                    const nuevoStock = varianteData.stock_actual - item.cantidad;
                    await supabase.from('producto_variantes').update({ stock_actual: nuevoStock }).eq('id', item.variante_id);
                    await supabase.from('kardex_inventario').insert([{
                        variante_id: item.variante_id, tipo_movimiento: 'Salida', cantidad: item.cantidad,
                        fecha_hora: fecha_hora, motivo: `Venta POS (Pedido #${pedido.id})`
                    }]);
                }
            }
        }

        let detallesParaCocina = [];
        let soloKMerch = true; 

        for (let item of detalles) {
            if (item.variante_id) {
                const { data: infoProd } = await supabase
                    .from('producto_variantes')
                    .select('productos ( categoria_id )')
                    .eq('id', item.variante_id)
                    .single();

                if (infoProd && infoProd.productos && infoProd.productos.categoria_id !== 6) {
                    detallesParaCocina.push(item);
                    soloKMerch = false; 
                }
            }
        }

        if (soloKMerch) {
            await supabase.from('pedidos').update({ estado: 'Completado' }).eq('id', pedido.id);
        }

        if (detallesParaCocina.length > 0) {
            io.emit('nuevo-pedido', { pedido_id: pedido.id, observaciones: pedido.observaciones, detalles: detallesParaCocina });
        }

        const premiosAProcesar = premios_canjeados || [];
        if (celular_cliente && celular_cliente.trim() !== '') {
            const celular = celular_cliente.trim();
            const stickersGanados = total >= 14000 ? 1 : 0;
            const stickersGastados = premiosAProcesar.reduce((sum, p) => sum + p.costo_stickers, 0);

            const { data: clienteExistente } = await supabase.from('clientes').select('cantidad_stickers').eq('celular', celular).single();

            if (clienteExistente) {
                const nuevoSaldo = clienteExistente.cantidad_stickers + stickersGanados - stickersGastados;
                await supabase.from('clientes').update({ cantidad_stickers: nuevoSaldo }).eq('celular', celular);
            } else if (stickersGanados > 0) {
                await supabase.from('clientes').insert([{ celular: celular, cantidad_stickers: 1 }]);
            }

            if (premiosAProcesar.length > 0) {
                const auditoria = premiosAProcesar.map(p => ({
                    celular_cliente: celular, premio_id: p.premio_id, turno_id: turno_id
                }));
                await supabase.from('historial_canjes').insert(auditoria);
            }
        }

        res.json({ mensaje: '¡Venta registrada!', pedido_id: pedido.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pedidos/pendientes', async (req, res) => {
    try {
        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select(`
                id, estado, observaciones,
                detalle_pedidos ( cantidad, notas_especiales, producto_variantes ( nombre_variante, productos ( nombre_producto, categoria_id ) ) )
            `)
            .eq('estado', 'Pendiente')
            .order('fecha_hora', { ascending: true }); 

        if (error) throw error;

        const pedidosFormateados = [];
        for (let pedido of pedidos) {
            let detallesParaCocina = [];
            for (let detalle of pedido.detalle_pedidos) {
                if (detalle.producto_variantes?.productos?.categoria_id !== 6) {
                    detallesParaCocina.push({
                        cantidad: detalle.cantidad, nombre: detalle.producto_variantes?.productos?.nombre_producto,
                        variante: detalle.producto_variantes?.nombre_variante, notas: detalle.notas_especiales
                    });
                }
            }
            if (detallesParaCocina.length > 0) {
                pedidosFormateados.push({ pedido_id: pedido.id, observaciones: pedido.observaciones, detalles: detallesParaCocina });
            }
        }
        res.json(pedidosFormateados);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pedidos/historial-hoy', async (req, res) => {
    try {
        const ahora = new Date();
        const horaColombia = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
        horaColombia.setUTCHours(0, 0, 0, 0);
        const inicioDelDiaColombia = new Date(horaColombia.getTime() + (5 * 60 * 60 * 1000)).toISOString();

        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select(`
                id, estado, fecha_hora, observaciones,
                detalle_pedidos ( cantidad, notas_especiales, producto_variantes ( nombre_variante, productos ( nombre_producto, categoria_id ) ) )
            `)
            .gte('fecha_hora', inicioDelDiaColombia)
            .order('fecha_hora', { ascending: false });

        if (error) throw error;

        const historialFormateado = [];
        for (let pedido of pedidos) {
            let detallesParaCocina = [];
            for (let detalle of pedido.detalle_pedidos) {
                if (detalle.producto_variantes?.productos?.categoria_id !== 6) {
                    detallesParaCocina.push({
                        cantidad: detalle.cantidad, nombre: detalle.producto_variantes?.productos?.nombre_producto,
                        variante: detalle.producto_variantes?.nombre_variante, notas: detalle.notas_especiales
                    });
                }
            }
            if (detallesParaCocina.length > 0) {
                const horaLocal = new Date(pedido.fecha_hora).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
                historialFormateado.push({
                    pedido_id: pedido.id, estado: pedido.estado, hora: horaLocal,
                    observaciones: pedido.observaciones, detalles: detallesParaCocina
                });
            }
        }
        res.json(historialFormateado);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pedidos/historial-caja-hoy', async (req, res) => {
    try {
        const ahora = new Date();
        const horaColombia = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
        horaColombia.setUTCHours(0, 0, 0, 0);
        const inicioDelDiaColombia = new Date(horaColombia.getTime() + (5 * 60 * 60 * 1000)).toISOString();

        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select(`
                id, estado, fecha_hora, total, metodo_pago, observaciones,
                detalle_pedidos ( cantidad, subtotal, notas_especiales, producto_variantes ( nombre_variante, productos ( nombre_producto ) ) )
            `)
            .gte('fecha_hora', inicioDelDiaColombia)
            .order('fecha_hora', { ascending: false });

        if (error) throw error;

        const historialCaja = pedidos.map(pedido => {
            const horaLocal = new Date(pedido.fecha_hora).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
            return {
                pedido_id: pedido.id, estado: pedido.estado, hora: horaLocal, total: pedido.total,
                metodo_pago: pedido.metodo_pago, observaciones: pedido.observaciones,
                detalles: pedido.detalle_pedidos.map(d => ({
                    cantidad: d.cantidad, subtotal: d.subtotal, nombre: d.producto_variantes?.productos?.nombre_producto,
                    variante: d.producto_variantes?.nombre_variante, notas: d.notas_especiales
                }))
            };
        });
        res.json(historialCaja);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/cuadre', async (req, res) => {
    try {
        const ahora = new Date();
        const horaColombia = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
        horaColombia.setUTCHours(0, 0, 0, 0);
        const inicioDelDiaColombia = new Date(horaColombia.getTime() + (5 * 60 * 60 * 1000)).toISOString();

        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select('total, metodo_pago')
            .gte('fecha_hora', inicioDelDiaColombia); 

        if (error) throw error;

        let reporte = { Efectivo: 0, Nequi: 0, QR: 0, Total_General: 0, Cantidad_Pedidos: pedidos.length };

        pedidos.forEach(pedido => {
            const monto = parseFloat(pedido.total);
            const metodo = pedido.metodo_pago.trim().toLowerCase();
            if (metodo === 'efectivo') reporte.Efectivo += monto;
            else if (metodo === 'nequi') reporte.Nequi += monto;
            else if (metodo === 'qr' || metodo === 'qr bold') reporte.QR += monto;
            reporte.Total_General += monto;
        });

        res.json(reporte);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/pedidos/:id/completar', async (req, res) => {
    try {
        const { error } = await supabase.from('pedidos').update({ estado: 'Completado' }).eq('id', req.params.id);
        if (error) throw error;
        res.json({ mensaje: 'Pedido marcado como listo exitosamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno al actualizar el estado' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const { data: user, error } = await supabase.from('usuarios').select('*').eq('nombre', usuario).eq('pin_seguridad', password).single();
        if (error || !user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        res.json({ mensaje: '¡Bienvenido!', id: user.id, rol: user.rol, usuario: user.nombre });
    } catch (error) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/turnos/activo', async (req, res) => {
    try {
        const { data, error } = await supabase.from('turnos_caja').select('*').eq('estado', 'Abierto').maybeSingle(); 
        if (error) throw error;
        res.json({ activo: !!data, turno: data });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/turnos/abrir', async (req, res) => {
    try {
        const { usuario_id, monto_base_apertura } = req.body;
        const { data, error } = await supabase.from('turnos_caja').insert([{
            usuario_id, monto_base_apertura, fecha_apertura: new Date().toISOString(), estado: 'Abierto'
        }]).select().single();
        if (error) throw error;
        res.json({ mensaje: 'Caja abierta con éxito', turno: data });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/turnos/cerrar', async (req, res) => {
    try {
        const { turno_id, efectivo_fisico_contado, notas_cierre } = req.body;
        const gastos_caja = 0; 
        const { data: turno, error: errorTurno } = await supabase.from('turnos_caja').select('monto_base_apertura').eq('id', turno_id).single();
        if (errorTurno) throw errorTurno;

        const { data: pedidos, error: errorPedidos } = await supabase.from('pedidos').select('total, metodo_pago').eq('turno_id', turno_id);
        if (errorPedidos) throw errorPedidos;

        let ventas_efectivo = 0, ventas_transferencia = 0, ventas_qr = 0;
        pedidos.forEach(p => {
            if (p.metodo_pago === 'Efectivo') ventas_efectivo += p.total;
            if (p.metodo_pago === 'Transferencia') ventas_transferencia += p.total;
            if (p.metodo_pago === 'QR') ventas_qr += p.total;
        });

        const efectivo_teorico = turno.monto_base_apertura + ventas_efectivo - gastos_caja;
        const descuadre = efectivo_fisico_contado - efectivo_teorico;

        const { data: turnoCerrado, error: errorUpdate } = await supabase.from('turnos_caja').update({
            fecha_cierre: new Date().toISOString(), estado: 'Cerrado', total_ventas_efectivo: ventas_efectivo,
            total_ventas_transferencia: ventas_transferencia, total_ventas_qr: ventas_qr, total_gastos_caja: gastos_caja,
            efectivo_teorico, efectivo_fisico_contado, descuadre, notas_cierre: notas_cierre || ''
        }).eq('id', turno_id).select().single();
        
        if (errorUpdate) throw errorUpdate;
        res.json({ mensaje: 'Turno cerrado', turno: turnoCerrado });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/turnos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('turnos_caja').select('*').order('fecha_apertura', { ascending: false }).limit(30);
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/productos/:id/estado', async (req, res) => {
    try {
        const { data, error } = await supabase.from('productos').update({ disponible: req.body.disponible }).eq('id', req.params.id).select().single();
        if (error) throw error;
        res.json({ mensaje: 'Estado actualizado correctamente', producto: data });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/productos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('productos').select(`
            id, nombre_producto, categoria_id, disponible, controla_inventario, imagen,
            producto_variantes (id, nombre_variante, precio, stock_actual, stock_minimo)
        `);
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/productos', async (req, res) => {
    try {
        const { nombre_producto, categoria_id, disponible, controla_inventario, imagen, variantes } = req.body;
        const { data: prodData, error: prodError } = await supabase.from('productos')
            .insert([{ nombre_producto, categoria_id, disponible, controla_inventario, imagen }]).select().single();
            
        if (prodError) throw prodError;
        
        if (variantes && variantes.length > 0) {
            const listaVariantes = variantes.map(v => ({
                producto_id: prodData.id, nombre_variante: v.nombre_variante, precio: parseFloat(v.precio),
                stock_actual: parseInt(v.stock_actual) || 0, stock_minimo: parseInt(v.stock_minimo) || 0, codigo_barras: v.codigo_barras || null
            }));
            const { error: varError } = await supabase.from('producto_variantes').insert(listaVariantes);
            if (varError) throw varError;
        }        
        res.json({ mensaje: 'Producto y variantes creados con éxito' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/productos/masivo', async (req, res) => {
    try {
        const productosCSV = req.body; 
        for (let item of productosCSV) {
            let { data: productoExistente, error: errorBusqueda } = await supabase.from('productos')
                .select('id').eq('nombre_producto', item.nombre_producto.trim()).eq('categoria_id', parseInt(item.categoria_id)).maybeSingle();

            let idProductoMaestro;
            if (productoExistente) {
                idProductoMaestro = productoExistente.id;
            } else {
                const { data: prodData, error: prodError } = await supabase.from('productos').insert([{ 
                    nombre_producto: item.nombre_producto.trim(), categoria_id: parseInt(item.categoria_id), 
                    disponible: true, controla_inventario: true, imagen: '' 
                }]).select().single();
                if (prodError) throw prodError;
                idProductoMaestro = prodData.id;
            }

            const { error: varError } = await supabase.from('producto_variantes').insert([{
                producto_id: idProductoMaestro, nombre_variante: item.nombre_variante || 'Única', precio: parseFloat(item.precio),
                stock_actual: parseInt(item.stock_actual) || 0, stock_minimo: parseInt(item.stock_minimo) || 0, codigo_barras: item.codigo_barras || null
            }]);
            if (varError) throw varError;
        }
        res.json({ mensaje: '¡Carga masiva procesada y agrupada correctamente!' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await supabase.from('producto_variantes').delete().eq('producto_id', req.params.id);
        const { error } = await supabase.from('productos').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ mensaje: 'Producto eliminado' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/inventario/ingreso', async (req, res) => {
    try {
        const { variante_id, cantidad, motivo } = req.body;
        const { data: variante, error: errorVar } = await supabase.from('producto_variantes').select('stock_actual').eq('id', variante_id).single();
        if (errorVar) throw errorVar;
        
        const nuevoStock = (variante.stock_actual || 0) + parseInt(cantidad);
        await supabase.from('producto_variantes').update({ stock_actual: nuevoStock }).eq('id', variante_id);
        const { error: errorKardex } = await supabase.from('kardex_inventario').insert([{
            variante_id: variante_id, tipo_movimiento: 'Entrada', cantidad: parseInt(cantidad), motivo: motivo || 'Ingreso de mercancía'
        }]);

        if (errorKardex) throw errorKardex;
        res.json({ mensaje: '¡Inventario actualizado con éxito!', nuevoStock });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/kardex', async (req, res) => {
    try {
        const { data, error } = await supabase.from('kardex_inventario').select(`
            id, tipo_movimiento, cantidad, fecha_hora, motivo, producto_variantes ( nombre_variante, productos ( nombre_producto ) )
        `).order('fecha_hora', { ascending: false }).limit(50); 
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/gastos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('gastos').select('*').order('fecha_hora', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/gastos', async (req, res) => {
    try {
        const { turno_id, fecha_hora, categoria_gasto, descripcion, monto, usuario_id } = req.body;
        const { data, error } = await supabase.from('gastos').insert([{ 
            turno_id: turno_id || null, fecha_hora: fecha_hora || new Date().toISOString(), categoria_gasto: categoria_gasto || 'Otros', 
            descripcion: descripcion || '', monto: monto, usuario_id: usuario_id || null 
        }]).select().single();
        if (error) throw error;
        res.json({ mensaje: '¡Gasto registrado con éxito!', gasto: data });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/reportes/dashboard', async (req, res) => {
    try {
        const { inicio, fin } = req.query; 
        const { data: pedidos, error: errPedidos } = await supabase.from('pedidos').select(`
            id, fecha_hora, total, estado,
            detalle_pedidos ( cantidad, subtotal, producto_variantes ( nombre_variante, productos ( nombre_producto, categoria_id ) ) )
        `).gte('fecha_hora', inicio).lte('fecha_hora', fin).neq('estado', 'Cancelado');                   
        if (errPedidos) throw errPedidos;

        let ventasTotales = 0, ventasPorHora = Array(24).fill(0), ventasPorDia = { 'Domingo':0, 'Lunes':0, 'Martes':0, 'Miércoles':0, 'Jueves':0, 'Viernes':0, 'Sábado':0 };
        const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        let rankingProductos = {};

        pedidos.forEach(p => {
            ventasTotales += parseFloat(p.total);
            const fechaColombia = new Date(new Date(p.fecha_hora).getTime() - (5 * 60 * 60 * 1000));
            ventasPorHora[fechaColombia.getUTCHours()] += 1; 
            ventasPorDia[diasSemana[fechaColombia.getUTCDay()]] += 1;

            p.detalle_pedidos.forEach(d => {
                const cat = d.producto_variantes?.productos?.categoria_id;
                const nombre = `${d.producto_variantes?.productos?.nombre_producto} (${d.producto_variantes?.nombre_variante})`;
                if (!rankingProductos[nombre]) rankingProductos[nombre] = { cantidad: 0, categoria: cat, ingresos: 0 };
                rankingProductos[nombre].cantidad += d.cantidad;
                rankingProductos[nombre].ingresos += d.subtotal;
            });
        });

        const rankingArray = Object.keys(rankingProductos).map(k => ({ nombre: k, ...rankingProductos[k] })).sort((a, b) => b.cantidad - a.cantidad);
        const { data: inventario, error: errInv } = await supabase.from('producto_variantes').select(`
            stock_actual, stock_minimo, nombre_variante, productos ( nombre_producto, categoria_id, controla_inventario )
        `);
        if (errInv) throw errInv;

        res.json({
            totalIngresos: ventasTotales, totalPedidos: pedidos.length, ventasPorHora, ventasPorDia,
            rankingProductos: rankingArray, inventario: inventario.filter(i => i.productos && i.productos.controla_inventario)
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// --- NUEVAS RUTAS DE FIDELIZACIÓN ---
// ==========================================

app.get('/api/clientes/todos', async (req, res) => {
    try {
        const { data: clientes, error } = await supabase.from('clientes')
            .select('celular, nombre, fecha_nacimiento');
        if (error) throw error;
        res.json(clientes);
    } catch (error) { res.status(500).json({ error: 'Error al consultar clientes' }); }
});

app.get('/api/clientes/:celular', async (req, res) => {
    try {
        const { data: cliente, error } = await supabase.from('clientes').select('nombre, cantidad_stickers').eq('celular', req.params.celular).single();
        if (error || !cliente) return res.json({ existe: false, cantidad_stickers: 0, nombre: null });
        res.json({ existe: true, cantidad_stickers: cliente.cantidad_stickers, nombre: cliente.nombre });
    } catch (error) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.get('/api/clientes/:celular/premios-disponibles', async (req, res) => {
    try {
        const celular = req.params.celular;
        const { data: cliente } = await supabase.from('clientes').select('cantidad_stickers').eq('celular', celular).single();
        if (!cliente) return res.json({ stickers: 0, premios: [] });

        const { data: premios } = await supabase.from('premios_fidelizacion').select(`
            id, costo_stickers, variante_id_referencia, producto_variantes ( nombre_variante, productos ( nombre_producto ) )
        `).eq('estado', true).lte('costo_stickers', cliente.cantidad_stickers).order('costo_stickers', { ascending: false });

        const premiosFormateados = (premios || []).map(p => ({
            id: p.id, costo_stickers: p.costo_stickers, variante_id_referencia: p.variante_id_referencia,
            nombre_premio: `${p.producto_variantes?.productos?.nombre_producto || 'Producto'} (${p.producto_variantes?.nombre_variante || 'Variante'})`
        }));
        res.json({ stickers: cliente.cantidad_stickers, premios: premiosFormateados });
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/clientes/:celular/perfil', async (req, res) => {
    try {
        const { data: cliente } = await supabase.from('clientes').select('nombre, fecha_nacimiento, cantidad_stickers').eq('celular', req.params.celular).single();
        if (!cliente) return res.json({ existe: false });

        const { data: premios } = await supabase.from('premios_fidelizacion').select('costo_stickers, producto_variantes(nombre_variante, productos(nombre_producto))').eq('estado', true).order('costo_stickers', { ascending: true });
        const premiosFormateados = (premios || []).map(p => ({
            costos: p.costo_stickers, nombre: `${p.producto_variantes.productos.nombre_producto} (${p.producto_variantes.nombre_variante})`
        }));
        res.json({ existe: true, ...cliente, premios: premiosFormateados });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/clientes/:celular', async (req, res) => {
    try {
        const celular = req.params.celular;
        const { nombre, fecha_nacimiento } = req.body;
        const { data: cliente } = await supabase.from('clientes').select('nombre, cantidad_stickers').eq('celular', celular).single();

        let nuevosStickers = cliente.cantidad_stickers;
        let ganoSticker = (!cliente.nombre && nombre && nombre.trim() !== '');
        if (ganoSticker) nuevosStickers += 1;

        await supabase.from('clientes').update({ nombre, fecha_nacimiento, cantidad_stickers: nuevosStickers }).eq('celular', celular);
        res.json({ success: true, ganoSticker, totalStickers: nuevosStickers });
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
});

// ==========================================
// --- RUTAS ADMIN PREMIOS ---
// ==========================================

app.get('/api/admin/premios', async (req, res) => {
    try {
        const { data, error } = await supabase.from('premios_fidelizacion').select(`
            id, costo_stickers, estado, producto_variantes ( nombre_variante, productos ( nombre_producto ) )
        `).order('id', { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/premios/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('premios_fidelizacion').update({ estado: req.body.estado }).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/historial-canjes', async (req, res) => {
    try {
        const { data, error } = await supabase.from('historial_canjes').select(`
            id, fecha_canje, celular_cliente, turno_id, premios_fidelizacion ( producto_variantes ( nombre_variante, productos ( nombre_producto ) ) )
        `).order('fecha_canje', { ascending: false }).limit(100);
        if (error) throw error;
        res.json(data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/admin/premios', async (req, res) => {
    try {
        const { error } = await supabase.from('premios_fidelizacion').insert([{ 
            variante_id_referencia: req.body.variante_id, costo_stickers: req.body.costo_stickers, estado: true 
        }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Servidor y Tiempo Real corriendo a máxima velocidad en el puerto ${PORT}`);
});