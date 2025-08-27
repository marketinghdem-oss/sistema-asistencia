const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const xlsx = require('xlsx');

// --- CONFIGURACIÓN INICIAL ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());
const PORT = 3000;

// --- CONFIGURACIÓN DE LA OFICINA ---
const OFFICE_COORDS = {
    latitude: -0.32550,
    longitude: -78.44028
};
const ALLOWED_RADIUS_METERS = 2000;

// --- FUNCIÓN PARA CALCULAR DISTANCIA ---
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- MIDDLEWARE DE AUTENTICACIÓN ---
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(403).json({ success: false, message: 'Acceso no autorizado.' });
    const idToken = authHeader.split('Bearer ')[1];
    try {
        req.user = await admin.auth().verifyIdToken(idToken);
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: 'Token inválido.' });
    }
};

// --- RUTA DE MARCACIÓN (Sin cambios) ---
app.post('/marcar', authMiddleware, async (req, res) => {
    // ... (El código de esta función no ha cambiado y funciona correctamente)
    const { checkinType, location } = req.body;
    const userEmail = req.user.email;

    if (!checkinType || !location) {
        return res.status(400).json({ success: false, message: 'Faltan datos en la petición.' });
    }

    const distance = getDistanceFromLatLonInMeters(OFFICE_COORDS.latitude, OFFICE_COORDS.longitude, location.latitude, location.longitude);
    if (distance > ALLOWED_RADIUS_METERS) {
        return res.status(400).json({ success: false, message: `Marcación rechazada. Estás a ${distance.toFixed(0)}m de la oficina.` });
    }

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const snapshot = await db.collection('marcaciones')
            .where('empleadoEmail', '==', userEmail)
            .where('timestamp', '>=', today)
            .where('timestamp', '<', tomorrow)
            .get();

        const todaysCheckins = snapshot.docs.map(doc => doc.data()).sort((a, b) => a.timestamp.toDate() - b.timestamp.toDate());
        
        if (todaysCheckins.length > 0) {
            const lastCheckinTime = todaysCheckins[todaysCheckins.length - 1].timestamp.toDate();
            const now = new Date();
            const minutesSinceLastCheckin = (now - lastCheckinTime) / (1000 * 60);
            if (minutesSinceLastCheckin < 15) {
                return res.status(400).json({ success: false, message: `Debes esperar 15 minutos. Faltan ${Math.ceil(15 - minutesSinceLastCheckin)} min.` });
            }
        }

        const checkinTypes = todaysCheckins.map(c => c.tipoDeMarcacion);
        const lastCheckinType = checkinTypes.length > 0 ? checkinTypes[checkinTypes.length - 1] : null;

        const checkinLogic = {
            'Entrada': () => checkinTypes.includes('Entrada') ? "Ya registraste tu entrada hoy." : null,
            'Inicio Almuerzo': () => lastCheckinType !== 'Entrada' ? "Debes registrar tu 'Entrada' primero." : null,
            'Fin Almuerzo': () => lastCheckinType !== 'Inicio Almuerzo' ? "Debes registrar tu 'Inicio Almuerzo' primero." : null,
            'Salida': () => lastCheckinType !== 'Fin Almuerzo' ? "Debes registrar tu 'Fin Almuerzo' primero." : null
        };
        
        const validationError = checkinLogic[checkinType] ? checkinLogic[checkinType]() : "Tipo de marcación inválido.";
        if (validationError) return res.status(400).json({ success: false, message: validationError });
        if (checkinTypes.length >= 4) return res.status(400).json({ success: false, message: "Ya has completado tus 4 marcaciones del día." });

        const marcacion = {
            empleadoEmail: userEmail,
            tipoDeMarcacion: checkinType,
            timestamp: new Date(),
            ubicacion: new admin.firestore.GeoPoint(location.latitude, location.longitude),
            distanciaOficinaMetros: parseFloat(distance.toFixed(2))
        };
        
        await db.collection('marcaciones').add(marcacion);
        
        let dynamicMessage = `'${checkinType}' registrada con éxito.`;
        if (checkinType === 'Salida') dynamicMessage = '¡Terminaste tu jornada! Nos vemos mañana.';
        
        res.status(200).json({ success: true, message: dynamicMessage });

    } catch (error) {
        console.error('SERVER CRITICAL ERROR:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});

// --- RUTA PARA EXPORTAR REPORTE (VERSIÓN A PRUEBA DE ERRORES) ---
app.get('/exportar', async (req, res) => {
    try {
        console.log("Iniciando exportación de Excel...");
        // 1. CONSULTA SIMPLE: Traemos todos los documentos.
        const snapshot = await db.collection('marcaciones').get();
        if (snapshot.empty) {
            return res.status(404).send('No hay marcaciones para exportar.');
        }
        console.log(`Se encontraron ${snapshot.docs.length} registros en total.`);

        // 2. PROCESAMIENTO EN EL SERVIDOR: Agrupamos los datos aquí.
        const dailyData = {};
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            // Verificación de seguridad por si algún registro antiguo no tiene timestamp
            if (!data.timestamp) return;

            const date = data.timestamp.toDate().toISOString().split('T')[0];
            const employee = data.empleadoEmail;
            if (!dailyData[employee]) dailyData[employee] = {};
            if (!dailyData[employee][date]) dailyData[employee][date] = {};
            dailyData[employee][date][data.tipoDeMarcacion] = data.timestamp.toDate();
        });
        console.log("Datos agrupados por empleado y día.");

        // 3. CÁLCULO DE HORAS
        const report = [];
        for (const employee in dailyData) {
            for (const date in dailyData[employee]) {
                const day = dailyData[employee][date];
                const entrada = day['Entrada'];
                const salida = day['Salida'];
                const inicioAlmuerzo = day['Inicio Almuerzo'];
                const finAlmuerzo = day['Fin Almuerzo'];

                let horasTrabajadas = 'N/A';
                if (entrada && salida) {
                    let diffMs = salida - entrada;
                    if (inicioAlmuerzo && finAlmuerzo) {
                        diffMs -= (finAlmuerzo - inicioAlmuerzo);
                    }
                    const hours = Math.floor(diffMs / 3600000);
                    const minutes = Math.floor((diffMs % 3600000) / 60000);
                    horasTrabajadas = `${hours}h ${minutes}m`;
                }
                
                report.push({
                    Empleado: employee,
                    Fecha: date,
                    Hora_Entrada: entrada ? entrada.toLocaleTimeString('es-EC') : 'N/A',
                    Hora_Salida: salida ? salida.toLocaleTimeString('es-EC') : 'N/A',
                    Horas_Trabajadas: horasTrabajadas
                });
            }
        }
        console.log("Cálculo de horas completado. Generando archivo Excel...");

        // 4. GENERACIÓN DEL ARCHIVO EXCEL
        const worksheet = xlsx.utils.json_to_sheet(report);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Resumen Diario');
        const buffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.setHeader('Content-Disposition', 'attachment; filename="ResumenDeAsistencia.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
        console.log("¡Reporte de Excel enviado con éxito!");

    } catch (error) {
        console.error('Error al exportar a Excel:', error);
        res.status(500).send('Error al generar el reporte.');
    }
});

// --- INICIAR EL SERVIDOR ---
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
