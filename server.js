require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- NUEVO: Configuración para el tiempo real (WebSockets) ---
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); // Envolvemos Express con el servidor HTTP
const io = new Server(server, { cors: { origin: "*" } }); // Activamos el walkie-talkie
io.on('connection', (socket) => {
    console.log('🔌 ¡Una pantalla se ha conectado al sistema en vivo!');
});

// -------------------------------------------------------------

app.use(cors());
app.use(express.json());
// Esto le dice al servidor que muestre los archivos de la carpeta frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// --- NUEVO: Permitir que el servidor muestre las pantallas ---
app.use(express.static('frontend'));


const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get('/', (req, res) => {
    res.send('¡El servidor POS de la heladería está vivo! 🍦');
});

// --- NUEVA RUTA: Obtener el catálogo de categorías ---
app.get('/api/categorias', async (req, res) => {
    try {
        // Pedimos a Supabase todos los registros de la tabla 'categorias'
        const { data, error } = await supabase
            .from('categorias')
            .select('*');

        // Si hay un error, lo lanzamos
        if (error) throw error;

        // Si todo sale bien, enviamos los datos en formato JSON
        res.json(data);
    } catch (error) {
        console.error("Error al obtener categorías:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVA RUTA: Obtener el menú completo (Productos + Tamaños/Precios) ---
app.get('/api/menu', async (req, res) => {
    try {
        // Le pedimos a Supabase los productos y, al mismo tiempo, sus variantes
        const { data, error } = await supabase
            .from('productos')
            .select(`
                id,
                nombre_producto,
                categoria_id,
                producto_variantes (
                    id,
                    nombre_variante,
                    precio
                )
            `)
            .eq('disponible', true); // Solo traemos los que estén activos para la venta

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Error al obtener el menú:", error);
        res.status(500).json({ error: error.message });
    }
});


// --- NUEVA RUTA INTEGRADA: Registrar venta, descontar stock y enviar a tablet ---
app.post('/api/pedidos', async (req, res) => {
    try {
        const { total, metodo_pago, detalles, turno_id } = req.body;
        const fecha_hora = new Date().toISOString();

        // 1. Guardar el encabezado del pedido
        const { data: pedido, error: errorPedido } = await supabase
            .from('pedidos')
            .insert([{
                turno_id: turno_id, // Quitamos el "|| 1" porque ya tienes control de turnos real
                fecha_hora: fecha_hora,
                total: total,
                metodo_pago: metodo_pago,
                estado: 'Pendiente' // Se va directo a la tablet
            }])
            .select()
            .single();

        if (errorPedido) throw errorPedido;

        // 2. Preparar e insertar la lista de productos (Tu lógica exacta)
        const detallesParaInsertar = detalles.map(item => ({
            pedido_id: pedido.id,
            producto_variante_id: item.variante_id,
            cantidad: item.cantidad,
            subtotal: item.subtotal,
            notas_especiales: item.notas
        }));

        const { error: errorDetalles } = await supabase
            .from('detalle_pedidos')
            .insert(detallesParaInsertar);

        if (errorDetalles) throw errorDetalles;

        // 3. ¡NUEVA MAGIA! Descontar inventario solo si el producto lo requiere
        for (let item of detalles) {
            const { data: varianteData, error: errorVar } = await supabase
                .from('producto_variantes')
                .select(`
                    stock_actual, 
                    productos ( controla_inventario )
                `)
                .eq('id', item.variante_id)
                .single();

            if (varianteData && varianteData.productos.controla_inventario) {
                const nuevoStock = varianteData.stock_actual - item.cantidad;
                
                await supabase
                    .from('producto_variantes')
                    .update({ stock_actual: nuevoStock })
                    .eq('id', item.variante_id);
            }
        }

        // 4. ¡FILTRO INTELIGENTE PARA LA TABLET!
        // Consultamos la categoría de cada producto del detalle para filtrar solo los que van a cocina
        let detallesParaCocina = [];

        for (let item of detalles) {
            const { data: infoProd } = await supabase
                .from('producto_variantes')
                .select('productos ( categoria_id )')
                .eq('id', item.variante_id)
                .single();

            // Si el producto NO es de la categoría 6 (K-Merch), sí va a la tablet
            if (infoProd && infoProd.productos && infoProd.productos.categoria_id !== 6) {
                detallesParaCocina.push(item);
            }
        }

        // Si quedó al menos un producto de cocina, emitimos la orden filtrada a la tablet
        if (detallesParaCocina.length > 0) {
            io.emit('nuevo-pedido', { 
                pedido_id: pedido.id, 
                detalles: detallesParaCocina // Mandamos solo lo que se cocina
            });
        }
        // ------------------------------------------------------------------------

        // 5. Responder con éxito
        res.json({ 
            mensaje: '¡Venta registrada y stock actualizado!', 
            pedido_id: pedido.id 
        });

    } catch (error) {
        console.error("Error al registrar la venta:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVA RUTA MEJORADA: Reporte de Cuadre de Caja (Con Zona Horaria Colombia) ---
app.get('/api/cuadre', async (req, res) => {
    try {
        // Ajuste estricto para la Zona Horaria de Colombia (UTC-5)
        const ahora = new Date();
        const horaColombia = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
        horaColombia.setUTCHours(0, 0, 0, 0); // Calculamos la medianoche exacta en Colombia
        const inicioDelDiaColombia = new Date(horaColombia.getTime() + (5 * 60 * 60 * 1000)).toISOString();

        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select('total, metodo_pago')
            .gte('fecha_hora', inicioDelDiaColombia); 

        if (error) throw error;

        let reporte = {
            Efectivo: 0,
            Nequi: 0,
            QR: 0, 
            Total_General: 0,
            Cantidad_Pedidos: pedidos.length
        };

        pedidos.forEach(pedido => {
            const monto = parseFloat(pedido.total);
            const metodo = pedido.metodo_pago.trim().toLowerCase();

            if (metodo === 'efectivo') {
                reporte.Efectivo += monto;
            } else if (metodo === 'nequi') {
                reporte.Nequi += monto;
            } else if (metodo === 'qr' || metodo === 'qr bold') {
                reporte.QR += monto;
            }
            reporte.Total_General += monto;
        });

        res.json(reporte);

    } catch (error) {
        console.error("Error al generar el cuadre:", error);
        res.status(500).json({ error: error.message });
    }
});


// --- NUEVA RUTA: Obtener pedidos pendientes para la tablet (Rescate tras hibernación) ---
app.get('/api/pedidos/pendientes', async (req, res) => {
    try {
        // 1. Buscamos pedidos con estado 'Pendiente', trayendo sus detalles y nombres unidos
        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select(`
                id,
                detalle_pedidos (
                    cantidad,
                    notas_especiales,
                    producto_variantes (
                        nombre_variante,
                        productos (
                            nombre_producto,
                            categoria_id
                        )
                    )
                )
            `)
            .eq('estado', 'Pendiente')
            .order('fecha_hora', { ascending: true }); // Ordenamos de más antiguo a más nuevo

        if (error) throw error;

        // 2. Formateamos los datos para que sean EXACTAMENTE iguales a los que envía el Socket.io
        const pedidosFormateados = [];

        for (let pedido of pedidos) {
            let detallesParaCocina = [];

            // Revisamos cada ítem del pedido
            for (let detalle of pedido.detalle_pedidos) {
                const categoria = detalle.producto_variantes?.productos?.categoria_id;
                
                // 3. Filtramos para NO enviar el K-Merch (Categoría 6) a la cocina
                if (categoria !== 6) {
                    detallesParaCocina.push({
                        cantidad: detalle.cantidad,
                        nombre: detalle.producto_variantes?.productos?.nombre_producto,
                        variante: detalle.producto_variantes?.nombre_variante,
                        notas: detalle.notas_especiales
                    });
                }
            }

            // 4. Solo lo agregamos a la lista de la tablet si quedaron productos por cocinar
            if (detallesParaCocina.length > 0) {
                pedidosFormateados.push({
                    pedido_id: pedido.id,
                    detalles: detallesParaCocina
                });
            }
        }

        // 5. Enviamos la lista final a la tablet
        res.json(pedidosFormateados);

    } catch (error) {
        console.error("Error al obtener pedidos pendientes:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVA RUTA: Obtener el historial completo de cocina del día actual (Con Zona Horaria Colombia) ---
app.get('/api/pedidos/historial-hoy', async (req, res) => {
    try {
        // Ajuste estricto para la Zona Horaria de Colombia (UTC-5)
        const ahora = new Date();
        const horaColombia = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
        horaColombia.setUTCHours(0, 0, 0, 0);
        const inicioDelDiaColombia = new Date(horaColombia.getTime() + (5 * 60 * 60 * 1000)).toISOString();

        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select(`
                id,
                estado,
                fecha_hora,
                detalle_pedidos (
                    cantidad,
                    notas_especiales,
                    producto_variantes (
                        nombre_variante,
                        productos ( nombre_producto, categoria_id )
                    )
                )
            `)
            .gte('fecha_hora', inicioDelDiaColombia)
            .order('fecha_hora', { ascending: false });

        if (error) throw error;

        const historialFormateado = [];

        for (let pedido of pedidos) {
            let detallesParaCocina = [];

            for (let detalle of pedido.detalle_pedidos) {
                const categoria = detalle.producto_variantes?.productos?.categoria_id;
                if (categoria !== 6) {
                    detallesParaCocina.push({
                        cantidad: detalle.cantidad,
                        nombre: detalle.producto_variantes?.productos?.nombre_producto,
                        variante: detalle.producto_variantes?.nombre_variante,
                        notas: detalle.notas_especiales
                    });
                }
            }

            if (detallesParaCocina.length > 0) {
                // Convertimos la hora UTC a la hora local de Colombia para que la tablet la muestre bien
                const horaLocal = new Date(pedido.fecha_hora).toLocaleTimeString('es-CO', { 
                    timeZone: 'America/Bogota', 
                    hour: '2-digit', 
                    minute: '2-digit' 
                });
                
                historialFormateado.push({
                    pedido_id: pedido.id,
                    estado: pedido.estado,
                    hora: horaLocal,
                    detalles: detallesParaCocina
                });
            }
        }

        res.json(historialFormateado);

    } catch (error) {
        console.error("Error al obtener historial de hoy:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVA RUTA: Historial completo para la Caja (Incluye precios y K-Merch) ---
app.get('/api/pedidos/historial-caja-hoy', async (req, res) => {
    try {
        // Ajuste estricto para la Zona Horaria de Colombia (UTC-5)
        const ahora = new Date();
        const horaColombia = new Date(ahora.getTime() - (5 * 60 * 60 * 1000));
        horaColombia.setUTCHours(0, 0, 0, 0);
        const inicioDelDiaColombia = new Date(horaColombia.getTime() + (5 * 60 * 60 * 1000)).toISOString();

        const { data: pedidos, error } = await supabase
            .from('pedidos')
            .select(`
                id, estado, fecha_hora, total, metodo_pago,
                detalle_pedidos (
                    cantidad, subtotal, notas_especiales,
                    producto_variantes (
                        nombre_variante,
                        productos ( nombre_producto )
                    )
                )
            `)
            .gte('fecha_hora', inicioDelDiaColombia)
            .order('fecha_hora', { ascending: false });

        if (error) throw error;

        // Formateamos los datos para enviarlos limpios al frontend
        const historialCaja = pedidos.map(pedido => {
            const horaLocal = new Date(pedido.fecha_hora).toLocaleTimeString('es-CO', { 
                timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' 
            });
            
            return {
                pedido_id: pedido.id,
                estado: pedido.estado,
                hora: horaLocal,
                total: pedido.total,
                metodo_pago: pedido.metodo_pago,
                detalles: pedido.detalle_pedidos.map(d => ({
                    cantidad: d.cantidad,
                    subtotal: d.subtotal,
                    nombre: d.producto_variantes?.productos?.nombre_producto,
                    variante: d.producto_variantes?.nombre_variante,
                    notas: d.notas_especiales
                }))
            };
        });

        res.json(historialCaja);

    } catch (error) {
        console.error("Error al obtener historial de caja:", error);
        res.status(500).json({ error: error.message });
    }
});



// --- RUTA PARA MARCAR UN PEDIDO COMO COMPLETADO ---
app.put('/api/pedidos/:id/completar', async (req, res) => {
    try {
        const { id } = req.params;

        const { data, error } = await supabase
            .from('pedidos') // Asegúrate de que el nombre de tu tabla sea 'pedidos'
            .update({ estado: 'Completado' }) // O el nombre de la columna que uses para el estado (ej: 'listo', 'estado')
            .eq('id', id);

        if (error) throw error;

        res.json({ mensaje: 'Pedido marcado como listo exitosamente' });
    } catch (error) {
        console.error("Error al actualizar pedido:", error);
        res.status(500).json({ error: 'Error interno al actualizar el estado' });
    }
});

// --- RUTA DE LOGIN CORREGIDA ---
app.post('/api/login', async (req, res) => {
    try {
        // 1. Recibimos 'usuario' y 'password' que envía el login.html
        const { usuario, password } = req.body;

        // 2. Buscamos en tu tabla 'usuarios' (validando nombre y pin/contraseña)
        // Nota: Asegúrate de si en tu base de datos la columna de la contraseña se llama 'pin_seguridad' o 'password'
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('nombre', usuario) 
            .eq('pin_seguridad', password) // Si tu columna en Supabase se llama 'password', cámbialo por .eq('password', password)
            .single();

        // 3. Si hay error o no coinciden, rebotamos la conexión
        if (error || !user) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }

        // 4. Si todo está correcto, enviamos el rol, el nombre y el ID
        res.json({ 
            mensaje: '¡Bienvenido!', 
            id: user.id,
            rol: user.rol, 
            usuario: user.nombre 
        });

    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});



// ==========================================
// --- MÓDULO DE TURNOS DE CAJA (SEORI) ---
// ==========================================

// 1. Verificar si hay un turno abierto actualmente
app.get('/api/turnos/activo', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('turnos_caja')
            .select('*')
            .eq('estado', 'Abierto')
            .maybeSingle(); // maybeSingle devuelve null si no hay turnos abiertos, sin lanzar error

        if (error) throw error;
        
        // Respondemos si hay un turno activo y sus datos
        res.json({ activo: !!data, turno: data });
    } catch (error) {
        console.error("Error al verificar turno:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Abrir un nuevo turno de caja
app.post('/api/turnos/abrir', async (req, res) => {
    try {
        const { usuario_id, monto_base_apertura } = req.body;
        
        const { data, error } = await supabase
            .from('turnos_caja')
            .insert([{
                usuario_id: usuario_id,
                monto_base_apertura: monto_base_apertura,
                fecha_apertura: new Date().toISOString(),
                estado: 'Abierto'
            }])
            .select()
            .single();

        if (error) throw error;
        
        res.json({ mensaje: 'Caja abierta con éxito', turno: data });
    } catch (error) {
        console.error("Error al abrir turno:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Cerrar turno y calcular el cuadre de caja automáticamente
app.post('/api/turnos/cerrar', async (req, res) => {
    try {
        const { turno_id, efectivo_fisico_contado, notas_cierre } = req.body;
        const gastos_caja = 0; // Por ahora lo dejamos en 0

        // 1. Obtener la base inicial del turno
        const { data: turno, error: errorTurno } = await supabase
            .from('turnos_caja')
            .select('monto_base_apertura')
            .eq('id', turno_id)
            .single();
        if (errorTurno) throw errorTurno;

        // 2. Obtener todas las ventas registradas en este turno
        const { data: pedidos, error: errorPedidos } = await supabase
            .from('pedidos')
            .select('total, metodo_pago')
            .eq('turno_id', turno_id);
        if (errorPedidos) throw errorPedidos;

        // 3. Sumar el dinero por cada método de pago
        let ventas_efectivo = 0;
        let ventas_transferencia = 0;
        let ventas_qr = 0;

        pedidos.forEach(p => {
            if (p.metodo_pago === 'Efectivo') ventas_efectivo += p.total;
            if (p.metodo_pago === 'Transferencia') ventas_transferencia += p.total;
            if (p.metodo_pago === 'QR') ventas_qr += p.total;
        });

        // 4. Calcular el teórico (Lo que DEBERÍA haber en la gaveta)
        const efectivo_teorico = turno.monto_base_apertura + ventas_efectivo - gastos_caja;
        
        // 5. Calcular el descuadre (Lo que entregó el cajero - Lo teórico)
        const descuadre = efectivo_fisico_contado - efectivo_teorico;

        // 6. Guardar el cierre en la base de datos
        const { data: turnoCerrado, error: errorUpdate } = await supabase
            .from('turnos_caja')
            .update({
                fecha_cierre: new Date().toISOString(),
                estado: 'Cerrado',
                total_ventas_efectivo: ventas_efectivo,
                total_ventas_transferencia: ventas_transferencia,
                total_ventas_qr: ventas_qr,
                total_gastos_caja: gastos_caja,
                efectivo_teorico: efectivo_teorico,
                efectivo_fisico_contado: efectivo_fisico_contado,
                descuadre: descuadre,
                notas_cierre: notas_cierre || ''
            })
            .eq('id', turno_id)
            .select()
            .single();
        
        if (errorUpdate) throw errorUpdate;

        res.json({ mensaje: 'Turno cerrado', turno: turnoCerrado });
    } catch (error) {
        console.error("Error al cerrar turno:", error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Obtener el historial de turnos (Para el Panel Admin)
app.get('/api/turnos', async (req, res) => {
    try {
        // Traemos los últimos 30 turnos, ordenados del más reciente al más antiguo
        const { data, error } = await supabase
            .from('turnos_caja')
            .select('*')
            .order('fecha_apertura', { ascending: false })
            .limit(30);

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Error al obtener el historial de turnos:", error);
        res.status(500).json({ error: error.message });
    }
});

// 5. Actualizar disponibilidad de un producto (Prender / Apagar en Inventario)
app.put('/api/productos/:id/estado', async (req, res) => {
    try {
        const { id } = req.params;
        const { disponible } = req.body; // true (prendido) o false (apagado)

        const { data, error } = await supabase
            .from('productos')
            .update({ disponible: disponible })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json({ mensaje: 'Estado actualizado correctamente', producto: data });
    } catch (error) {
        console.error("Error al actualizar disponibilidad:", error);
        res.status(500).json({ error: error.message });
    }
});


// --- RUTAS DE INVENTARIO (MODELO RELACIONAL) ---

// 1. Obtener productos y sus variantes anidadas
app.get('/api/productos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('productos')
            .select(`
                id, nombre_producto, categoria_id, disponible, controla_inventario, imagen,
                producto_variantes (id, nombre_variante, precio, stock_actual, stock_minimo)
            `);
        
        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Error cargando inventario:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Crear un nuevo producto MAESTRO y sus VARIANTES
app.post('/api/productos', async (req, res) => {
    try {
        const { nombre_producto, categoria_id, disponible, controla_inventario, imagen, variantes } = req.body;
        
        // A. Guardar en tabla 'productos'
        const { data: prodData, error: prodError } = await supabase
            .from('productos')
            .insert([{ nombre_producto, categoria_id, disponible, controla_inventario, imagen }])
            .select()
            .single();
            
        if (prodError) throw prodError;
        
        // B. Guardar en tabla 'producto_variantes' (amarradas al ID nuevo)
        if (variantes && variantes.length > 0) {
            const listaVariantes = variantes.map(v => ({
                producto_id: prodData.id,
                nombre_variante: v.nombre_variante,
                precio: parseFloat(v.precio),
                stock_actual: parseInt(v.stock_actual) || 0,
                stock_minimo: parseInt(v.stock_minimo) || 0
            }));
            
            const { error: varError } = await supabase
                .from('producto_variantes')
                .insert(listaVariantes);
                
            if (varError) throw varError;
        }
        
        res.json({ mensaje: 'Producto y variantes creados con éxito' });
    } catch (error) {
        console.error("Error creando producto:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Eliminar producto (Supabase eliminará las variantes solas si configuraste CASCADE, o puedes borrarlas manual)
app.delete('/api/productos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Primero borramos sus variantes por seguridad
        await supabase.from('producto_variantes').delete().eq('producto_id', id);
        // Luego el producto
        const { error } = await supabase.from('productos').delete().eq('id', id);
        
        if (error) throw error;
        res.json({ mensaje: 'Producto eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- RUTAS DE GASTOS ---

// 1. Obtener la lista de todos los gastos (ordenados del más reciente al más antiguo)
app.get('/api/gastos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('gastos')
            .select('*')
            .order('fecha_hora', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Error al obtener gastos:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Registrar un nuevo gasto enviado desde gastos.html
app.post('/api/gastos', async (req, res) => {
    try {
        const { turno_id, fecha_hora, categoria_gasto, descripcion, monto, usuario_id } = req.body;

        const { data, error } = await supabase
            .from('gastos')
            .insert([{ 
                turno_id: turno_id || null, 
                fecha_hora: fecha_hora || new Date().toISOString(), 
                categoria_gasto: categoria_gasto || 'Otros', 
                descripcion: descripcion || '', 
                monto: monto, 
                usuario_id: usuario_id || null 
            }])
            .select()
            .single();

        if (error) throw error;
        res.json({ mensaje: '¡Gasto registrado con éxito!', gasto: data });
    } catch (error) {
        console.error("Error al registrar gasto:", error);
        res.status(500).json({ error: error.message });
    }
});

// 1. Esto le dice al servidor que muestre los archivos de la carpeta frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// 2. Ruta principal para enviar directo al login
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

// 3. Aquí va tu código original de .listen que enciende el servidor


// Arrancamos el servidor completo (Express + Sockets)
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Servidor y Tiempo Real corriendo a máxima velocidad en el puerto ${PORT}`);
});
