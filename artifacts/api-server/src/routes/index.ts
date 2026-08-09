import { Router, type IRouter } from "express";
import healthRouter from "./health";
import articlesRouter from "./articles";
import chatRouter from "./chat";
import adminRouter from "./admin";
import whatsappRouter from "./whatsapp";
import mediaRouter from "./media";
import userWhatsappRouter from "./userWhatsapp";
import captureRouter from "./capture";
import panelRouter from "./panel";
import adminPanelRouter from "./adminPanel";

const router: IRouter = Router();

router.use(healthRouter);
router.use(articlesRouter);
router.use(chatRouter);
router.use(adminRouter);
router.use(whatsappRouter);
router.use(mediaRouter);
router.use(userWhatsappRouter);
router.use(captureRouter);
router.use(panelRouter);
router.use(adminPanelRouter);

export default router;
