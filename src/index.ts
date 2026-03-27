import dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response } from 'express';
import { pushAssets } from './lib/assets';
import { pushToEnvironment } from './lib/push-to-env';

const app = express();
const port = process.env.PORT || 3000;
const deployKey = process.env.DEPLOYMENT_KEY;
const vercelDeployWebhook = process.env.VERCEL_DEPLOY_WEBHOOK;

app.use(express.json());

app.get('/', (req: Request, res: Response): any => {
  return res.status(200).json({ message: 'All your base are belong to us.' });
});

app.post('/api/deploy', async (req: Request, res: Response): Promise<any> => {
  const headerKey = req.header('x-deployment-key');
  if (!deployKey || headerKey !== deployKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log('Pushing assets to s3');
  pushAssets().then(() => {
    // console.log('Assets pushed to s3');
    console.log('Pushing pages to environment');
    pushToEnvironment().then(() => {
      // console.log('Deployment promise resolved');
      if (vercelDeployWebhook) {
        console.log('Triggering Vercel deployment');
        fetch(vercelDeployWebhook, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          // body: JSON.stringify({
          //   deploymentKey,
          //   pageId,
          // }),
        }).catch((error) => {
          console.error('Error triggering Vercel deployment:', error);
        });
      }
    }).catch((error) => {
      console.error('Error pushing to environment:', error);
    });

  }).catch((error) => {
    console.error('Error pushing assets to s3:', error);
  });
  
  return res.status(200).json({ message: 'Deployment triggered' });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});