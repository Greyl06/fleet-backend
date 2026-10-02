import { Router, Request, Response } from 'express';
import { VehicleService } from '../services/vehicle.service.js';
import { requirePermission } from '../middleware/auth.js';

export const vehicleRouter = Router();

// GET /api/vehicles - List all vehicles with live PMS calculations
vehicleRouter.get('/', requirePermission('read', 'Vehicle'), async (req: Request, res: Response) => {
  try {
    const list = await VehicleService.listVehicles();
    res.json(list);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// GET /api/vehicles/:id
vehicleRouter.get('/:id', requirePermission('read', 'Vehicle'), async (req: Request, res: Response) => {
  try {
    const vehicle = await VehicleService.getVehicleById(String(req.params.id));
    if (!vehicle) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }
    res.json(vehicle);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// POST /api/vehicles - Register new vehicle
vehicleRouter.post('/', requirePermission('create', 'Vehicle'), async (req: Request, res: Response) => {
  try {
    const { plateNumber, model, vehicleType, assignedDriver, currentKm, lastPmsKm, pmsIntervalKm } = req.body;
    if (!plateNumber) {
      res.status(400).json({ error: 'plateNumber is required' });
      return;
    }

    const vehicle = await VehicleService.createVehicle({
      plateNumber,
      model,
      vehicleType,
      assignedDriver,
      currentKm,
      lastPmsKm,
      pmsIntervalKm,
    });

    res.status(201).json(vehicle);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});

// POST /api/vehicles/:id/mileage - Direct odometer update
vehicleRouter.post('/:id/mileage', requirePermission('update', 'Vehicle'), async (req: Request, res: Response) => {
  try {
    const { endingKm } = req.body;
    if (typeof endingKm !== 'number') {
      res.status(400).json({ error: 'endingKm (number) is required' });
      return;
    }

    const updated = await VehicleService.updateMileage(String(req.params.id), endingKm);
    res.json(updated);
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: error.message });
  }
});
