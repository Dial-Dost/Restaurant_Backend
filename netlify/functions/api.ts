import express, { Request, Response } from 'express';
import serverless from 'serverless-http';
import { app as createApp } from '../../index.js'; // your main express app

const app = createApp;

export const handler = serverless(app);