import {
    handleCloudinaryDelete,
    handleCloudinaryUpload,
    handleGetCloudinaryResource,
} from './cloudinary'
import fs from 'fs'
import path from 'path'
import { Request, Response } from 'express'
import puppeteer from 'puppeteer'

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
    } catch (error) {
        return res.status(400).json({ message: 'Error', error })
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
        const browser = await puppeteer.launch({
            headless: 'new',
            // defaultViewport: { width: 1920, height: 1080 },
            args: minimal_args,
            userDataDir: 'data',
        })
        console.log(browser)
        const page = await browser.newPage()
        page.setDefaultTimeout(300000)
        await page.setViewport({ width: 1920, height: 1080 })

        await page.tracing.start({ path: 'trace.json', screenshots: true })
        console.time('goto')
        await page.goto(url)
        console.timeEnd('goto')
        await page.tracing.stop()
        await page.waitForSelector('body', { visible: true })

        const outputPath = `public/screenshots/${Date.now()}.jpeg`
        console.log(outputPath)
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

    try {
        await getScreenshot()
    } catch (error) {
        console.log(error)
        throw error
    }
}

export const postScreenshotHandler = async (req: Request, res: Response) => {
    console.log(req.body)
    try {
        const result = await handlePostRequest(req.body)

        return res.status(201).json({ message: 'Success', result })
    } catch (error) {
        console.error(error)
        return res.status(400).json({ message: 'Error', error })
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
    } catch (error) {
        console.error(error)
        return res.status(400).json({ message: 'Error', error })
    }
}
