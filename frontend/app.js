// Dirección de tu servidor local
const API_URL = 'http://localhost:3001';

// Variables globales para la memoria del carrito
let carrito = [];
let totalCarrito = 0;

// Función para descargar y mostrar el menú
async function cargarMenu() {
    try {
        const respuesta = await fetch(`${API_URL}/api/menu`);
        const productos = await respuesta.json();
        
        const contenedor = document.getElementById('cuadricula-productos');
        contenedor.innerHTML = ''; 
        
        productos.forEach(producto => {
            producto.producto_variantes.forEach(variante => {
                const tarjeta = document.createElement('div');
                tarjeta.style.backgroundColor = 'white';
                tarjeta.style.padding = '15px';
                tarjeta.style.borderRadius = '8px';
                tarjeta.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
                tarjeta.style.cursor = 'pointer';
                
                tarjeta.innerHTML = `
                    <h3 style="font-size: 16px; margin-bottom: 5px; color: #2c3e50;">${producto.nombre_producto}</h3>
                    <p style="color: #7f8c8d; font-size: 14px; margin-bottom: 10px;">Tamaño: ${variante.nombre_variante}</p>
                    <strong style="color: #e94560; font-size: 18px;">$${variante.precio}</strong>
                `;
                
                // ¡AQUÍ ESTÁ EL CAMBIO! Ahora envía el producto al carrito
                tarjeta.onclick = () => agregarAlCarrito(producto, variante);
                
                contenedor.appendChild(tarjeta);
            });
        });
    } catch (error) {
        console.error("Error al conectar con el servidor:", error);
    }
}

// Función para procesar lo que se elige
function agregarAlCarrito(producto, variante) {
    // 1. Buscamos si ese tamaño exacto ya está en el carrito
    const itemExistente = carrito.find(item => item.variante_id === variante.id);
    
    if (itemExistente) {
        // Si ya está, solo sumamos 1 a la cantidad y actualizamos su subtotal
        itemExistente.cantidad++;
        itemExistente.subtotal += variante.precio;
    } else {
        // Si es nuevo, lo agregamos a la lista
        carrito.push({
            variante_id: variante.id,
            nombre: `${producto.nombre_producto} - ${variante.nombre_variante}`,
            cantidad: 1,
            precio: variante.precio,
            subtotal: variante.precio
        });
    }
    
    // 2. Le decimos a la pantalla que se actualice
    actualizarPantallaCarrito();
}

// Función para dibujar el ticket en el panel derecho
// --- FUNCIÓN ACTUALIZADA: Dibuja el carrito con botón de borrar ---
function actualizarPantallaCarrito() {
    const lista = document.getElementById('lista-carrito');
    lista.innerHTML = ''; // Limpiamos la zona visual
    totalCarrito = 0;     // Reiniciamos la suma desde cero
    
    carrito.forEach((item) => {
        totalCarrito += item.subtotal; 
        
        const div = document.createElement('div');
        div.style.borderBottom = '1px dashed #ccc';
        div.style.padding = '10px 0';
        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; color: #2c3e50;">
                <strong>${item.nombre}</strong>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <strong>$${item.subtotal}</strong>
                    <!-- NUEVO: Botón rojo para eliminar -->
                    <button onclick="eliminarDelCarrito(${item.variante_id})" style="background: #e74c3c; color: white; border: none; border-radius: 3px; cursor: pointer; padding: 2px 8px; font-weight: bold;">X</button>
                </div>
            </div>
            <div style="font-size: 13px; color: #7f8c8d;">
                Cant: ${item.cantidad} x $${item.precio}
            </div>
        `;
        lista.appendChild(div);
    });
    
    document.getElementById('total-venta').innerText = totalCarrito;
}

// --- NUEVA FUNCIÓN: Quitar producto del carrito ---
window.eliminarDelCarrito = function(id_a_borrar) {
    // Filtramos la memoria para conservar solo los que NO sean el id que queremos borrar
    carrito = carrito.filter(item => item.variante_id !== id_a_borrar);
    // Le pedimos a la pantalla que se redibuje con la nueva lista
    actualizarPantallaCarrito();
}
// Arrancar la función apenas cargue el archivo
cargarMenu();

// --- NUEVA FUNCIÓN: Enviar la venta al servidor ---
async function cobrarPedido() {
    // 1. Verificamos que haya algo que cobrar
    if (carrito.length === 0) {
        alert("El carrito está vacío. Agrega productos primero.");
        return;
    }

    try {
        // 2. Preparamos el paquete de datos igual a como lo espera el servidor
        const metodoSeleccionado = document.getElementById('metodo-pago').value;

        const venta = {
            total: totalCarrito,
            metodo_pago: metodoSeleccionado, 
            detalles: carrito.map(item => ({
                variante_id: item.variante_id,
                nombre: item.nombre, // <-- ¡AQUÍ ESTÁ EL CAMBIO! Le enviamos el nombre a la tablet
                cantidad: item.cantidad,
                subtotal: item.subtotal
            }))
        };

        // 3. Enviamos la orden al servidor (a la ruta que creamos antes)
        const respuesta = await fetch(`${API_URL}/api/pedidos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(venta)
        });

        const resultado = await respuesta.json();

        // 4. Si todo sale bien, avisamos y limpiamos el carrito para el siguiente cliente
        if (respuesta.ok) {
            // Mandamos la orden a la impresora térmica
            imprimirTicket(resultado.pedido_id, totalCarrito, metodoSeleccionado);
            
            // Vaciamos la memoria y la pantalla para el siguiente cliente
            carrito = []; 
            actualizarPantallaCarrito(); 
        } else {
            alert("Error al registrar la venta: " + resultado.error);
        }

    } catch (error) {
        console.error("Error al cobrar:", error);
        alert("Error de conexión al procesar el pago.");
    }
}

// 5. Conectar el botón verde con nuestra nueva función
document.getElementById('btn-cobrar').onclick = cobrarPedido;

// --- NUEVA FUNCIÓN: Generar e imprimir el ticket térmico de 80mm ---
function imprimirTicket(pedido_id, total, metodo_pago) {
    // 1. Obtenemos la fecha y hora de Colombia
    const fecha = new Date().toLocaleString('es-CO');

    // 2. Construimos el diseño del recibo (80mm = ~300px)
    let ticketHTML = `
        <div style="width: 300px; font-family: 'Courier New', Courier, monospace; font-size: 12px; color: black; background: white; margin: 0 auto;">
            <div style="text-align: center; margin-bottom: 10px;">
                <h2 style="margin: 0; font-size: 22px; font-weight: bold;">SEORI</h2>
                <p style="margin: 0; font-size: 14px;">Korean Ice</p>
                <!-- Aquí puedes poner la calle o barrio exacto en Caucasia -->
                <p style="margin: 0;">Dirección: Manzana 13 Casa 06, Barrio Altos de San Juan, Caucasia</p>
                <!-- Agrega tu número para que te pidan a domicilio -->
                <p style="margin: 0;">WhatsApp: 3052262767</p>
                <p style="margin: 0;">--------------------------------</p>
            </div>
            
            <p style="margin: 0;"><strong>Pedido:</strong> #${pedido_id}</p>
            <p style="margin: 0;"><strong>Fecha:</strong> ${fecha}</p>
            <p style="margin: 0;"><strong>Pago:</strong> ${metodo_pago}</p>
            <p style="margin: 0;">--------------------------------</p>
            
            <table style="width: 100%; font-size: 12px; margin-bottom: 10px; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px dashed black;">
                        <th style="text-align: left; padding-bottom: 3px;">Cant</th>
                        <th style="text-align: left; padding-bottom: 3px;">Producto</th>
                        <th style="text-align: right; padding-bottom: 3px;">Subtotal</th>
                    </tr>
                </thead>
                <tbody>
    `;

    // Agregamos cada producto del carrito al ticket
    carrito.forEach(item => {
        ticketHTML += `
                    <tr>
                        <td style="vertical-align: top; padding-top: 3px;">${item.cantidad}</td>
                        <td style="padding-right: 5px; padding-top: 3px;">${item.nombre}</td>
                        <td style="text-align: right; vertical-align: top; padding-top: 3px;">$${item.subtotal}</td>
                    </tr>
        `;
    });

    // Agregamos el total, el pie de página y el Código QR
    ticketHTML += `
                </tbody>
            </table>
            <p style="margin: 0;">--------------------------------</p>
            <h3 style="text-align: right; margin: 10px 0; font-size: 16px;">TOTAL: $${total}</h3>
            <p style="text-align: center; margin: 0;">¡Gracias por tu compra!</p>
            
            <!-- Generador automático de QR (ejemplo apuntando a Instagram) -->
            <div style="text-align: center; margin-top: 15px;">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=https://instagram.com/seori" alt="QR" style="width: 100px; height: 100px;">
            </div>
        </div>
    `;

    // 3. Abrimos una ventana temporal, imprimimos y cerramos sola
    const ventana = window.open('', '_blank', 'width=350,height=600');
    ventana.document.write(`
        <html>
            <head><title>Imprimiendo Ticket...</title></head>
            <body style="margin: 0; padding: 10px;" onload="window.print();">
                ${ticketHTML}
            </body>
        </html>
    `);
    ventana.document.close();
}