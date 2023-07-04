const chalk = require('chalk');
class ErrorHandler {

    constructor(){
    }

    public logWarn = (...args: any)=> {
     console.log(chalk.hex("#FFA500")(...args));
    }

   public logSuccess = (...args: any) => {
    console.log(chalk.green(...args));
   }

   public logInfo = (...args: any) => {
    console.log(chalk.yellow(...args));
   }

   public logTrace = (...args: any) =>{
    console.log(chalk.grey(...args));
   }
   
   public logError = (...args: any) =>{
    console.log(chalk.red(...args));
   }

   public logDebug = (...args: any[]) => {
    console.log(chalk.magenta(...args));
  };

  public logFatal = (...args: any[]) => {
    console.log(chalk.redBright(...args));
  };

}
export const Logging = new ErrorHandler();