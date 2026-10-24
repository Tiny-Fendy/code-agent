/**
 * Electron 主进程入口
 *
 * 启动流程全部收口在 AppBootstrap 中，这里只做入口调用。
 */

import { AppBootstrap } from './AppBootstrap';

void new AppBootstrap().bootstrap();
