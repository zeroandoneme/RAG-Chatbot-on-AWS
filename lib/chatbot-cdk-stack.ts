import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { aws_sagemaker as sagemaker } from 'aws-cdk-lib';
import { aws_secretsmanager as secretsmanager } from 'aws-cdk-lib';
import { aws_opensearchservice as opensearchservice } from 'aws-cdk-lib';
import { aws_lambda as lambda} from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import { HttpMethod } from 'aws-cdk-lib/aws-lambda';

export class ChatbotCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Model deployment configuration and Image uri 
    const ingestImageUri = "293175704869.dkr.ecr.eu-west-1.amazonaws.com/chatbot:ingest";
    const ingestInstanceType = "ml.m5.2xlarge";
    const ingestInstanceCount = 1;

    const answerImageUri = "293175704869.dkr.ecr.eu-west-1.amazonaws.com/chatbot:answer";
    const answerInstanceType = "ml.g5.8xlarge";
    const answerInstanceCount = 1;

    // S3 bucket where the lambda code is stored
    const modelBucket = new s3.Bucket(this, 'Chatbot-data', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Username parameter input for opensearch
    const masterUser = new cdk.CfnParameter(this, 'opensearchUsername', {
      type: 'String',
      description: 'Username for OpenSearch master user',
    });

    // Password parameter input for opensearch
    const masterPassword = new cdk.CfnParameter(this, 'opensearchPassword', {
      type: 'String',
      description: 'Password for OpenSearch master user',
    });

    // Opensearch access policy
    const accessPolicy: any = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
             AWS: '*'
        },
        Action: 'es:*',
        Resource: `arn:aws:es:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:domain/*`
        }
    ]
    };

    // Creates a new OpensearchDomain
    const cfnDomain = new opensearchservice.CfnDomain(this, 'ChatbotDomain', {
      accessPolicies: accessPolicy,
      advancedSecurityOptions: {
        enabled: true,
        internalUserDatabaseEnabled: true,
        masterUserOptions: {
          masterUserName: masterUser.valueAsString,
          masterUserPassword: masterPassword.valueAsString,
        },
      },
      clusterConfig: {
        instanceCount: 2,
        instanceType: 't3.medium.search',
        zoneAwarenessConfig: {
          availabilityZoneCount: 2,
        },
        zoneAwarenessEnabled: true,
      },
      domainEndpointOptions: {
        enforceHttps: true,
      },
      ebsOptions: {
        ebsEnabled: true,
        iops: 3000,
        throughput: 125,
        volumeSize: 100,
        volumeType: 'gp3',
      },
      encryptionAtRestOptions: {
        enabled: true,
      },
      engineVersion: 'OpenSearch_2.7',
      nodeToNodeEncryptionOptions: {
        enabled: true,
      },
    });

    // Creates a new secret to store required inputs by the model for OpenSearch
    const cfnSecret = new secretsmanager.CfnSecret(this, 'opensearchSecret', {
      name: 'opensearch-secret',
      secretString: JSON.stringify({
        'MASTER_USERNAME': masterUser.valueAsString,
        'MASTER_PASSWORD': masterPassword.valueAsString,
        'OPENSEARCH_DOMAIN_ENDPOINT': cfnDomain.attrDomainEndpoint
      }),
    });
    cfnSecret.node.addDependency(cfnDomain)

    // Defines container for Ingest model
    const ingestDefinitionProperty: sagemaker.CfnModel.ContainerDefinitionProperty = {
      image: ingestImageUri,
      mode: 'SingleModel',
    };

    // Defines container for Query model
    const answerDefinitionProperty: sagemaker.CfnModel.ContainerDefinitionProperty = {
      image: answerImageUri,
      mode: 'SingleModel',
    };

    // iam role for both models provides required permissions
    const sagemakerRole = new iam.Role(this, 'sagemakerRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'Model deployment role',
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Allow the role to read, put, delete, and list objects in your S3 bucket
              actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
              resources: [modelBucket.bucketArn, `${modelBucket.bucketArn}/*`]
            }),
          ],
        }),
        // Allow the role to create and write to CloudWatch Logs for logging
        CloudWatchAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              resources: ["arn:aws:logs:*:*:*"]
            }),
          ],
        }),
        // Allow the role to pull images from your ECR repository
        ECRAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetAuthorizationToken"
              ],
              resources: [
                "*"
              ]
            }),
          ],
        }),
        // Allow the role to create SageMaker resources
        SageMakerAccess: new iam.PolicyDocument({
        statements: [
            new iam.PolicyStatement({
            actions: [
                "sagemaker:CreateModel",
                "sagemaker:CreateEndpoint",
                "sagemaker:CreateEndpointConfig"
            ],
            resources: ['*']
            }),
        ],
        }),
        OpenSearchAccess: new iam.PolicyDocument({
        statements: [
            new iam.PolicyStatement({
            actions: [
                "es:*"
            ],
            resources: ["*"]
            }),
        ],
        }),
        SecretsManagerAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "secretsmanager:GetSecretValue",
              ],
              resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${cfnSecret.name}*`],
            }),
          ],
        }),
      },
    });

    // Creates Ingest model
    const ingestSagemakerModel = new sagemaker.CfnModel(this, 'ingestCfnModel', {
      executionRoleArn: sagemakerRole.roleArn,
      modelName: 'chatbot-ingest',
      primaryContainer: ingestDefinitionProperty,
    });
    ingestSagemakerModel.node.addDependency(sagemakerRole,cfnSecret)

    // Creates Query model
    const answerSagemakerModel = new sagemaker.CfnModel(this, 'answerCfnModel', {
      executionRoleArn: sagemakerRole.roleArn,
      modelName: 'chatbot-answer',
      primaryContainer: answerDefinitionProperty,
    });
    answerSagemakerModel.node.addDependency(sagemakerRole,cfnSecret)

    // Ingest endpoint deployment
    const ingestEndpointConfig = new sagemaker.CfnEndpointConfig(this, 'ingestEndpointConfig', {
      productionVariants: [{
        initialVariantWeight: 1.0,
        modelName: ingestSagemakerModel.attrModelName,
        variantName: 'default',
        initialInstanceCount: ingestInstanceCount,
        instanceType: ingestInstanceType
      }],
    });
    ingestEndpointConfig.node.addDependency(ingestSagemakerModel)

    const ingestEndpoint = new sagemaker.CfnEndpoint(this, 'ingestEndpoint', {
       endpointConfigName: ingestEndpointConfig.attrEndpointConfigName,
    });

    // Query endpoint deployment
    const answerEndpointConfig = new sagemaker.CfnEndpointConfig(this, 'answerEndpointConfig', {
      productionVariants: [{
        initialVariantWeight: 1.0,
        modelName: answerSagemakerModel.attrModelName,
        variantName: 'default',
        initialInstanceCount: answerInstanceCount,
        instanceType: answerInstanceType
      }],
    });
    answerEndpointConfig.node.addDependency(answerSagemakerModel)

    const answerEndpoint = new sagemaker.CfnEndpoint(this, 'answerEndpoint', {
       endpointConfigName: answerEndpointConfig.attrEndpointConfigName,
    });

    // Uploads lambda code to s3 bucket
    const codeDeployment = new s3deploy.BucketDeployment(this, 'DeployScript', {
      sources: [s3deploy.Source.asset('code')],
      destinationBucket: modelBucket,
      destinationKeyPrefix: 'lambda-scripts'
    });
    codeDeployment.node.addDependency(modelBucket);

    // Lambda role for both endpoints 
    const chatbotLambdaRole = new iam.Role(this, 'chatbotLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: 'chatbotLambdaRole'
    });

    chatbotLambdaRole.addToPolicy(
    new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
        'sagemaker:InvokeEndpoint',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
    ],
    resources: [
        '*',
        `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
        `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:endpoint/${ingestEndpoint.attrEndpointName}`,
        `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:endpoint/${answerEndpoint.attrEndpointName}`
    ]
    }));

    // Lambda function to invoke Ingest endpoint
    const ingestLambda = new lambda.Function(this, 'ingestLambda', {
      code: lambda.Code.fromBucket(modelBucket, 'lambda-scripts/ingest-code.zip'),
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.lambda_handler',
      role: chatbotLambdaRole,
      functionName: 'chatbotIngest',
      timeout: Duration.minutes(1),
      environment: {
        ENDPOINT_NAME : ingestEndpoint.attrEndpointName,
      },
    });
    ingestLambda.node.addDependency(codeDeployment, chatbotLambdaRole);

    const ingestLambdaUrl = ingestLambda.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
        cors: {
          allowedOrigins: ['*'],
          allowedMethods: [HttpMethod.ALL]
      },
    });
    new CfnOutput(this, 'ingestLambdaUrl', {
        value: ingestLambdaUrl.url,
    });

    // Lambda function to invoke query endpoint
    const answerLambda = new lambda.Function(this, 'answerLambda', {
      code: lambda.Code.fromBucket(modelBucket, 'lambda-scripts/answer-code.zip'),
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.lambda_handler',
      role: chatbotLambdaRole,
      functionName: 'chatbotAnswer',
      timeout: Duration.minutes(1),
      environment: {
        ENDPOINT_NAME : answerEndpoint.attrEndpointName,
      },
    });
    answerLambda.node.addDependency(codeDeployment, chatbotLambdaRole);

    const answerLambdaUrl = answerLambda.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
        cors: {
          allowedOrigins: ['*'],
          allowedMethods: [HttpMethod.ALL]
      },
    });
    new CfnOutput(this, 'answerLambdaUrl', {
        value: answerLambdaUrl.url,
    });
  }
}


