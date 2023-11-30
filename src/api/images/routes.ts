import { Router } from 'express'
import {
    deleteScreenshotsHandler,
    getScreenshotHandler,
    postScreenshotHandler,
} from './handlers'

const router = Router()
router.post('/', postScreenshotHandler)
router.get('/', getScreenshotHandler)
router.delete('/:id', deleteScreenshotsHandler)

export default router
