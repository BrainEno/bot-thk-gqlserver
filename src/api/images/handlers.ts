import {
    handleCloudinaryDelete,
    handleCloudinaryUpload,
    handleGetCloudinaryResource,
} from './cloudinary'
import fs from 'fs'
import path from 'path'
import { Request, Response } from 'express'

const handleGetRequest = async (publicId: string) => {
    const uploads = await handleGetCloudinaryResource(publicId)

    return uploads
}

export const getScreenshotHandler = async (req: Request, res: Response) => {
    const { publicId } = req.body
    if (!publicId) throw new Error('publicId not provided')
    try {
        const result = await handleGetRequest(publicId)

        return res.status(200).json({ message: 'Success', result })
    } catch {
        return res.status(400).json({ message: 'Unable to retrieve image' })
    }
}

const minimal_args = [
    '--disable-dev-shm-usage',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-pings',
    '--no-sandbox',
    '--no-zygote',
    '--headless',
]

const handlePostRequest = async ({
    url,
    fullPage,
}: {
    url: string
    fullPage: boolean
}) => {
    const getScreenshot = async () => {
        const { default: puppeteer } = await import('puppeteer')
        const browser = await puppeteer.launch({
            headless: true,
            // defaultViewport: { width: 1920, height: 1080 },
            args: minimal_args,
            userDataDir: 'data',
        })
        const page = await browser.newPage()
        page.setDefaultTimeout(300000)
        await page.setViewport({ width: 1920, height: 1080 })

        await page.tracing.start({ path: 'trace.json', screenshots: true })
        await page.goto(url)
        await page.tracing.stop()
        await page.waitForSelector('body', { visible: true })

        const outputPath = `public/screenshots/${Date.now()}.jpeg`
        const dir = path.dirname(outputPath)

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir)
        }

        await page.screenshot({
            path: outputPath,
            fullPage,
            type: 'jpeg',
            quality: 80,
            encoding: 'base64',
        })

        await browser.close()

        const uploadResponse = await handleCloudinaryUpload({
            path: outputPath,
            folder: true,
        })

        fs.unlinkSync(outputPath)

        return uploadResponse
    }

    return getScreenshot()
}

export const postScreenshotHandler = async (req: Request, res: Response) => {
    try {
        const result = await handlePostRequest(req.body)

        return res.status(201).json({ message: 'Success', result })
    } catch {
        return res.status(400).json({ message: 'Unable to process screenshot request' })
    }
}

const handleDeleteRequest = (id: string) => {
    return handleCloudinaryDelete([id.replace(':', '/')])
}

export const deleteScreenshotsHandler = async (req: Request, res: Response) => {
    const { id } = req.query

    try {
        if (!id) {
            throw new Error('No ID provided')
        }

        const result = await handleDeleteRequest(id as string)

        return res.status(200).json({ message: 'Success', result })
    } catch {
        return res.status(400).json({ message: 'Unable to delete image' })
    }
}
